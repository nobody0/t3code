import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const startsKoWork = (
  events: ReadonlyArray<{ readonly type: string }>,
  effects: ReadonlyArray<{ readonly request: { readonly type: string } }>,
): boolean =>
  events.some((event) =>
    ["thread.created", "run.created", "run-attempt.created"].includes(event.type),
  ) ||
  effects.some((effect) =>
    [
      "provider-turn.start",
      "provider-turn.restart",
      "provider-turn.steer",
      "provider-runtime.continue",
    ].includes(effect.request.type),
  );

export class KoMaintenanceError extends Schema.TaggedError<KoMaintenanceError>()(
  "KoMaintenanceError",
  { reason: Schema.Literals(["draining", "unavailable"]), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "T3 is draining for managed maintenance. Retry after maintenance completes.";
  }
}
const isKoMaintenanceError = Schema.is(KoMaintenanceError);

// Filesystem admission protocol shared with the external rollout operator. A persistent fence
// never expires automatically: after a crash, only a reviewed recovery can remove it.
export const makeKoAdmission = Effect.fn("KoMaintenance.makeAdmission")(function* () {
  const environment = yield* HostProcess.Environment;
  const directory = environment.T3_KO_MAINTENANCE_DIR;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (directory !== undefined && !path.isAbsolute(directory)) {
    return yield* Effect.die(new Error("T3_KO_MAINTENANCE_DIR must be absolute."));
  }
  const admissions = directory === undefined ? undefined : path.join(directory, "admissions");
  if (directory !== undefined && admissions !== undefined) {
    yield* fs.makeDirectory(admissions, { recursive: true }).pipe(Effect.orDie);
    yield* fs
      .writeFileString(path.join(directory, "protocol.json"), '{"protocol":1}\n')
      .pipe(Effect.orDie);
  }
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | KoMaintenanceError, R> => {
    if (directory === undefined || admissions === undefined) return effect;
    const fence = path.join(directory, "fence");
    const refuseIfFenced = fs
      .exists(fence)
      .pipe(
        Effect.flatMap((fenced) =>
          fenced ? Effect.fail(new KoMaintenanceError({ reason: "draining" })) : Effect.void,
        ),
      );
    const acquire = Effect.gen(function* () {
      yield* refuseIfFenced;
      const permit = yield* fs.makeTempDirectory({ directory: admissions, prefix: "permit-" });
      // Publish the permit BEFORE the second fence check. Once the operator creates its fence,
      // every accepted operation is visible in admissions; later operations must refuse.
      yield* refuseIfFenced.pipe(
        Effect.onError(() => fs.remove(permit, { recursive: true }).pipe(Effect.orDie)),
      );
      return permit;
    }).pipe(
      Effect.mapError((cause) =>
        isKoMaintenanceError(cause)
          ? cause
          : new KoMaintenanceError({ reason: "unavailable", cause }),
      ),
    );
    return Effect.acquireUseRelease(
      acquire,
      () => effect,
      (permit) => fs.remove(permit, { recursive: true }).pipe(Effect.orDie),
    );
  };
});
