process.stdout.write(`${JSON.stringify({ status: "PASS", marker: "M11_CAPTURE_STDOUT_MARKER" })}\n`);
process.stderr.write("M11_CAPTURE_STDERR_MARKER\n");
process.exit(7);
