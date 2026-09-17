export async function runCliWithScriptedPseudoTerminal(
  args: string[],
  env: NodeJS.ProcessEnv,
  steps: Array<{ match: RegExp; input: string }>,
  timeoutMs = 20_000,
): Promise<{ status: number | null; output: string }> {
  const nodePty = await import("node-pty");
  const ptyEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const child = nodePty.spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    { cwd: process.cwd(), env: ptyEnv, name: "xterm-256color", cols: 80, rows: 24 },
  );
  let terminalOutput = "";
  let stepIndex = 0;
  const dataDisposable = child.onData((chunk) => {
    terminalOutput += chunk;
    const step = steps[stepIndex];
    if (step && step.match.test(terminalOutput)) {
      stepIndex += 1;
      child.write(`${step.input}\r`);
    }
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const status = await new Promise<number | null>((resolve) => {
    child.onExit(({ exitCode }) => resolve(exitCode));
  });
  clearTimeout(timer);
  dataDisposable.dispose();
  return { status, output: terminalOutput };
}
