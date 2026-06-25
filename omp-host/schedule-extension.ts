export function makeScheduleFactory(identity) {
  const platform = identity?.platform || "discord";
  const scope = identity?.guild || "";
  const origin = identity?.thread || "";
  const channel = identity?.channel || "";
  const createdBy = identity?.user || "";

  return function schedule(pi) {
    const z = pi.zod;

    const ok = (text, details) => ({ content: [{ type: "text", text }], details: details || {} });

    async function runPico(args) {
      let proc;
      try {
        proc = Bun.spawn(["pico", "schedule", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      } catch (e) {
        throw new Error(`could not run \`pico\` (${e?.message || e}). Is the pico CLI installed and on PATH?`);
      }
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout: stdout.trim(), stderr: stderr.trim() };
    }

    function parseJson(text) {
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }

    async function createOrList(args) {
      const r = await runPico(args);
      const parsed = parseJson(r.stdout);
      if (r.code !== 0) {
        throw new Error((parsed && parsed.error) || r.stdout || r.stderr || `pico exited ${r.code}`);
      }
      return parsed !== undefined ? parsed : r.stdout;
    }

    async function mutate(verb, id) {
      const args = [verb, id];
      if (scope) args.push("--scope", scope);
      const r = await runPico(args);
      if (r.code !== 0) {
        const parsed = parseJson(r.stdout);
        throw new Error((parsed && parsed.error) || r.stderr || r.stdout || `pico exited ${r.code}`);
      }
      return r.stdout || `${verb} ${id} ok`;
    }

    pi.registerTool({
      name: "schedule_create",
      label: "Schedule Create",
      description: [
        "Create a scheduled job that fires later with no user present: run an optional shell script first, then ",
        "optionally invoke the model. Provide a script, a prompt, or both (at least one is required). ",
        "mode 'continue' fires into THIS thread and reuses its session; 'fresh' opens a NEW thread + session in ",
        "the target channel on each run. ",
        "trigger.kind 'oneshot' needs `at` = a FUTURE absolute RFC3339 timestamp — resolve relative phrasing like ",
        "'in 2h' or 'tomorrow 9am' yourself from the current time in the runtime context. 'cron' needs `expr` = a ",
        "standard 5-field cron expression (minute hour day-of-month month day-of-week) plus optional `tz` (IANA ",
        "name, default UTC). 'interval' needs `every_secs` >= 60. ",
        "CRON DAY-OF-WEEK: write day-of-week as day NAMES (SUN, MON, TUE, WED, THU, FRI, SAT) or numbers where ",
        "1=Sunday..7=Saturday. NEVER use POSIX numbering — here 1=Sunday, not Monday. ",
        "Do NOT pass platform/guild/channel/user context: pico injects it from the session context.",
      ].join(""),
      parameters: z.object({
        name: z.string().describe("Short human-readable label for the schedule"),
        mode: z
          .enum(["continue", "fresh"])
          .describe("'continue' = this thread/session; 'fresh' = a new thread/session in the target channel"),
        trigger: z.object({
          kind: z.enum(["oneshot", "cron", "interval"]),
          at: z.string().optional().describe("oneshot: future absolute RFC3339, e.g. 2026-07-01T09:00:00-07:00"),
          expr: z.string().optional().describe("cron: standard 5-field expr, e.g. '0 9 * * MON'"),
          tz: z.string().optional().describe("cron: IANA timezone name, default UTC"),
          every_secs: z.number().optional().describe("interval: seconds between runs, minimum 60"),
        }),
        script: z
          .string()
          .optional()
          .describe("Optional shell script (bash -lc); stdout JSON {skip,context} gates the model run"),
        prompt: z.string().optional().describe("Optional instruction for the model when the job fires"),
        target_channel: z
          .string()
          .optional()
          .describe("fresh mode: channel id to open new threads in (default: the current channel)"),
      }),
      async execute(_id, p) {
        const payload = {
          name: p.name,
          mode: p.mode,
          trigger: p.trigger,
          platform,
        };
        if (scope) payload.scope = scope;
        if (origin) payload.origin = origin;
        if (createdBy) payload.created_by = createdBy;
        const target = p.target_channel !== undefined ? p.target_channel : channel;
        if (target) payload.target = target;
        if (p.script !== undefined) payload.script = p.script;
        if (p.prompt !== undefined) payload.prompt = p.prompt;
        const created = await createOrList(["create", "--json", JSON.stringify(payload)]);
        const id = created && created.id ? created.id : "";
        return ok(`Created schedule ${id} (${p.name})`, created || {});
      },
    });

    pi.registerTool({
      name: "schedule_list",
      label: "Schedule List",
      description: "List the scheduled jobs for this server (id, name, mode, trigger, next run, state).",
      parameters: z.object({}),
      async execute() {
        const listArgs = ["list", "--json"];
        if (scope) listArgs.push("--scope", scope);
        const items = await createOrList(listArgs);
        const arr = Array.isArray(items) ? items : [];
        if (arr.length === 0) return ok("No schedules.", { schedules: [] });
        const lines = arr.map((s) => {
          const t = s.trigger || {};
          const trig =
            t.kind === "oneshot"
              ? `oneshot ${t.at || ""}`
              : t.kind === "cron"
                ? `cron "${t.expr || ""}" (${t.tz || "UTC"})`
                : t.kind === "interval"
                  ? `every ${t.every_secs}s`
                  : t.kind || "?";
          return `• ${s.id} ${s.name} [${s.state}] ${s.mode} — ${trig} — next ${s.next_run_at}`;
        });
        return ok(lines.join("\n"), { schedules: arr });
      },
    });

    pi.registerTool({
      name: "schedule_remove",
      label: "Schedule Remove",
      description: "Delete a scheduled job by id.",
      parameters: z.object({ id: z.string() }),
      async execute(_id, p) {
        return ok(await mutate("remove", p.id), { id: p.id });
      },
    });

    pi.registerTool({
      name: "schedule_enable",
      label: "Schedule Enable",
      description: "Re-enable a disabled scheduled job by id.",
      parameters: z.object({ id: z.string() }),
      async execute(_id, p) {
        return ok(await mutate("enable", p.id), { id: p.id });
      },
    });

    pi.registerTool({
      name: "schedule_disable",
      label: "Schedule Disable",
      description: "Disable a scheduled job by id (kept, but stops firing).",
      parameters: z.object({ id: z.string() }),
      async execute(_id, p) {
        return ok(await mutate("disable", p.id), { id: p.id });
      },
    });
  };
}
