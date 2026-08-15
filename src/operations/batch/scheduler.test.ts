import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchScheduler,
  type BatchScheduledTask,
} from "./scheduler.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, "condition did not become true");
}

test("BatchScheduler respects caller concurrency, queues excess tasks, and preserves input result order", async () => {
  const scheduler = new BatchScheduler();
  const gates = Array.from({ length: 23 }, () => deferred<string>());
  let active = 0;
  let maxActive = 0;
  const started: number[] = [];
  const tasks: BatchScheduledTask<string>[] = gates.map((gate, index) => ({
    id: `task-${index}`,
    claims: [{ key: `/workspace/file-${index}.txt`, mode: "read" }],
    run: async () => {
      started.push(index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    },
  }));

  const resultPromise = scheduler.run(tasks, { concurrency: 10 });
  await waitUntil(() => started.length === 10);
  assert.equal(maxActive, 10);
  assert.deepEqual(started, Array.from({ length: 10 }, (_, index) => index));

  for (let index = 0; index < 10; index += 1) gates[index]!.resolve(`result-${index}`);
  await waitUntil(() => started.length === 20);
  assert.equal(maxActive, 10);
  for (let index = 10; index < 20; index += 1) gates[index]!.resolve(`result-${index}`);
  await waitUntil(() => started.length === 23);
  for (let index = 20; index < 23; index += 1) gates[index]!.resolve(`result-${index}`);

  const result = await resultPromise;
  assert.deepEqual(result.map((entry) => [
    entry.id,
    entry.status,
    entry.status === "done" ? entry.value : entry.error,
  ]), Array.from({ length: 23 }, (_, index) => [`task-${index}`, "done", `result-${index}`]));
});

test("BatchScheduler continues independent work after a task fails", async () => {
  const scheduler = new BatchScheduler();
  const started: string[] = [];
  const result = await scheduler.run([
    {
      id: "ok-a",
      claims: [],
      run: async () => {
        started.push("ok-a");
        return "a";
      },
    },
    {
      id: "bad",
      claims: [],
      run: async () => {
        started.push("bad");
        throw new Error("expected failure");
      },
    },
    {
      id: "ok-b",
      claims: [],
      run: async () => {
        started.push("ok-b");
        return "b";
      },
    },
  ], { concurrency: 3 });

  assert.deepEqual(started.sort(), ["bad", "ok-a", "ok-b"]);
  assert.equal(result[0]?.status, "done");
  assert.equal(result[1]?.status, "error");
  assert.match(result[1]?.error ?? "", /expected failure/);
  assert.equal(result[2]?.status, "done");
});

test("BatchScheduler serializes overlapping mutations while allowing read-read and disjoint work", async () => {
  const scheduler = new BatchScheduler();
  const gates = {
    readA: deferred<string>(),
    readA2: deferred<string>(),
    writeA: deferred<string>(),
    writeB: deferred<string>(),
  };
  const started: string[] = [];
  const task = (
    id: string,
    key: string,
    mode: "read" | "write",
    gate: Deferred<string>,
  ): BatchScheduledTask<string> => ({
    id,
    claims: [{ key, mode }],
    run: async () => {
      started.push(id);
      return gate.promise;
    },
  });

  const resultPromise = scheduler.run([
    task("read-a", "/workspace/a.txt", "read", gates.readA),
    task("read-a-2", "/workspace/a.txt", "read", gates.readA2),
    task("write-a", "/workspace/a.txt", "write", gates.writeA),
    task("write-b", "/workspace/b.txt", "write", gates.writeB),
  ], { concurrency: 4 });

  await waitUntil(() => started.length === 3);
  assert.deepEqual(started.sort(), ["read-a", "read-a-2", "write-b"]);
  gates.writeB.resolve("write-b");
  gates.readA.resolve("read-a");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started.includes("write-a"), false, "write must wait for both reads on the same path");
  gates.readA2.resolve("read-a-2");
  await waitUntil(() => started.includes("write-a"));
  gates.writeA.resolve("write-a");
  const result = await resultPromise;
  assert.ok(result.every((entry) => entry.status === "done"));
});

test("BatchScheduler treats ancestor and descendant write claims as conflicting", async () => {
  const scheduler = new BatchScheduler();
  const parent = deferred<string>();
  const child = deferred<string>();
  const started: string[] = [];
  const resultPromise = scheduler.run([
    {
      id: "delete-parent",
      claims: [{ key: "/workspace/dir", mode: "write" }],
      run: async () => {
        started.push("parent");
        return parent.promise;
      },
    },
    {
      id: "write-child",
      claims: [{ key: "/workspace/dir/file.txt", mode: "write" }],
      run: async () => {
        started.push("child");
        return child.promise;
      },
    },
  ], { concurrency: 2 });

  await waitUntil(() => started.length === 1);
  assert.deepEqual(started, ["parent"]);
  parent.resolve("parent");
  await waitUntil(() => started.length === 2);
  child.resolve("child");
  await resultPromise;
});

test("BatchScheduler runs exclusive tasks alone", async () => {
  const scheduler = new BatchScheduler();
  const first = deferred<string>();
  const exclusive = deferred<string>();
  const last = deferred<string>();
  const started: string[] = [];
  const resultPromise = scheduler.run([
    {
      id: "first",
      claims: [],
      run: async () => {
        started.push("first");
        return first.promise;
      },
    },
    {
      id: "shell",
      claims: [],
      exclusive: true,
      run: async () => {
        started.push("shell");
        return exclusive.promise;
      },
    },
    {
      id: "last",
      claims: [],
      run: async () => {
        started.push("last");
        return last.promise;
      },
    },
  ], { concurrency: 3 });

  await waitUntil(() => started.includes("first") && started.includes("last"));
  assert.equal(started.includes("shell"), false);
  first.resolve("first");
  last.resolve("last");
  await waitUntil(() => started.includes("shell"));
  exclusive.resolve("shell");
  await resultPromise;
});

test("BatchScheduler stops launching queued tasks after Host cancellation and shares the AbortSignal", async () => {
  const scheduler = new BatchScheduler();
  const controller = new AbortController();
  const started: string[] = [];
  const observedSignals: AbortSignal[] = [];
  const running = deferred<string>();
  const tasks: BatchScheduledTask<string>[] = [
    {
      id: "running",
      claims: [],
      run: async (signal) => {
        started.push("running");
        observedSignals.push(signal);
        signal.addEventListener("abort", () => running.reject(signal.reason), { once: true });
        return running.promise;
      },
    },
    ...Array.from({ length: 4 }, (_, index): BatchScheduledTask<string> => ({
      id: `queued-${index}`,
      claims: [],
      run: async (signal) => {
        started.push(`queued-${index}`);
        observedSignals.push(signal);
        return `queued-${index}`;
      },
    })),
  ];

  const resultPromise = scheduler.run(tasks, {
    concurrency: 1,
    signal: controller.signal,
  });
  await waitUntil(() => started.length === 1);
  controller.abort(new Error("host cancelled"));
  await assert.rejects(resultPromise, /host cancelled/);
  assert.deepEqual(started, ["running"]);
  assert.deepEqual(observedSignals, [controller.signal]);
});

test("BatchScheduler validates task count, unique ids, and concurrency", async () => {
  const scheduler = new BatchScheduler();
  const task = (id: string): BatchScheduledTask<string> => ({ id, claims: [], run: async () => id });
  await assert.rejects(scheduler.run([], {}), /1 and 100/i);
  await assert.rejects(scheduler.run(Array.from({ length: 101 }, (_, index) => task(String(index))), {}), /1 and 100/i);
  await assert.rejects(scheduler.run([task("same"), task("same")], {}), /unique/i);
  await assert.rejects(scheduler.run([task("one")], { concurrency: 0 }), /between 1 and 10/i);
  await assert.rejects(scheduler.run([task("one")], { concurrency: 11 }), /between 1 and 10/i);
  assert.deepEqual(await scheduler.run([task("one"), task("two")], {}), [
    { id: "one", status: "done", value: "one" },
    { id: "two", status: "done", value: "two" },
  ]);
});
