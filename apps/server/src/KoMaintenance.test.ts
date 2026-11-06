import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeKoAdmission } from "./KoMaintenance.ts";

it.effect("a draining owner refuses later work while an admitted operation drains", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const gate = yield* makeKoAdmission().pipe(
        Effect.provideService(HostProcess.Environment, { T3_KO_MAINTENANCE_DIR: directory }),
      );
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const running = yield* gate(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* fs.makeDirectory(path.join(directory, "fence"));
      assert.equal((yield* fs.readDirectory(path.join(directory, "admissions"))).length, 1);
      const refused = yield* gate(Effect.die(new Error("must not execute"))).pipe(Effect.flip);
      assert.equal(refused.reason, "draining");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(running);
      assert.deepEqual(yield* fs.readDirectory(path.join(directory, "admissions")), []);
      yield* fs.remove(path.join(directory, "fence"), { recursive: true });
      assert.equal(yield* gate(Effect.succeed("resumed")), "resumed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a fence created between the two admission checks cannot let work escape", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const racingFs = FileSystem.FileSystem.of({
        ...fs,
        makeTempDirectory: (options) =>
          fs
            .makeTempDirectory(options)
            .pipe(Effect.tap(() => fs.makeDirectory(path.join(directory, "fence")))),
      });
      const gate = yield* makeKoAdmission().pipe(
        Effect.provideService(HostProcess.Environment, { T3_KO_MAINTENANCE_DIR: directory }),
        Effect.provideService(FileSystem.FileSystem, racingFs),
      );
      assert.equal(
        (yield* gate(Effect.die(new Error("escaped"))).pipe(Effect.flip)).reason,
        "draining",
      );
      assert.deepEqual(yield* fs.readDirectory(path.join(directory, "admissions")), []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
