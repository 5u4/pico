export const evalWorkerScenarios: ReadonlyArray<readonly [scenario: string, description: string]> =
  [
    ["late-success", "delivers a late agent handle to a later cell"],
    ["late-error", "preserves the real manager-unavailable error in both cells"],
    ["caught-error", "does not fail a cell that handles its late bridge rejection"],
    ["chained-requests", "keeps immediate handle-method calls in the originating run"],
    ["exported-tool", "drains bridge continuations started by an exported tool"],
    ["race-local-loser", "does not wait for the pending local loser of Promise.race"],
    ["stale-continuation", "rejects bridge calls started after their run has finished"],
    ["close", "closes pending bridges without late results or escaping rejections"],
    ["dispose", "disposes pending bridges without waiting for unrelated local promises"],
    [
      "ipc-error-recovery",
      "reports IPC bridge errors and cancels without losing another worker's state",
    ],
  ];
