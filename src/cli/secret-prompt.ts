/** Read a passphrase without echoing it to an interactive terminal. */
export async function readHiddenSecret(prompt = "Passphrase: "): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Hidden passphrase input requires an interactive TTY.");
  }

  process.stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      process.stderr.write("\n");
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Passphrase input cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
