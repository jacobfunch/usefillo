// Real-TTY behavior of the interactive prompts — the lane piped tests can't
// see. Two founder-reported bugs live here: backspace must edit the buffer
// (not eat the question: readline owns the prompt via setPrompt), and Ctrl-C
// at ANY prompt must abort the command (exit 130) — at the optional name
// prompt a close/EOF reads as "skipped" and the command would otherwise
// continue and provision. Driven through python3's pty module; skips cleanly
// where python3 is unavailable.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ETX = "\u0003"; // Ctrl-C
const DEL = "\u007f"; // backspace

const probe = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("tty prompts: skipped (python3 with pty unavailable)");
  process.exit(0);
}

const gitcfg = join(mkdtempSync(join(tmpdir(), "fillo-ttycfg-")), "gitconfig");
writeFileSync(gitcfg, "[user]\n\temail = pty@probe.dev\n\tname = Pty Probe\n");

const DRIVER = String.raw`
import os, pty, select, signal, sys, time, tempfile, json, termios

spec = json.loads(sys.argv[1])

def run(steps, gitcfg):
    home = tempfile.mkdtemp()
    env = dict(os.environ, HOME=home, FILLO_API="http://127.0.0.1:9")
    env["GIT_CONFIG_GLOBAL"] = gitcfg
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["TERM"] = "xterm-256color"
    cli = os.path.abspath("dist/index.js")
    pid, fd = pty.fork()
    if pid == 0:
        # A worktree-local user.name/user.email must not change which prompt
        # this test sees. Run outside the repository and opt into only the
        # explicit global fixture above.
        attrs = termios.tcgetattr(0)
        attrs[6][termios.VERASE] = b"\x7f"
        termios.tcsetattr(0, termios.TCSANOW, attrs)
        os.chdir(home)
        os.execvpe("node", ["node", cli, "init"], env)
    out = b""; deadline = time.time() + 15; step = 0; code = None; sent_at = 0
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                c = os.read(fd, 4096)
                if c: out += c
            except OSError:
                # Linux: reading the pty master raises EIO once the child closes
                # its slave (i.e. it EXITED). Reap the real exit code here — a
                # clean exit is otherwise misread as TIMEOUT. macOS returns EOF
                # at this point instead of erroring, which is why it only ever
                # failed on CI's Linux runners.
                try:
                    _, status = os.waitpid(pid, 0)
                    code = os.waitstatus_to_exitcode(status)
                except ChildProcessError:
                    pass
                break
        if step < len(steps) and steps[step][0].encode() in out and time.time() - sent_at > 0.2:
            time.sleep(0.1)
            os.write(fd, steps[step][1].encode("latin1"))
            sent_at = time.time(); step += 1
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                code = os.waitstatus_to_exitcode(status); break
        except ChildProcessError:
            break
    if code is None:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: os.waitpid(pid, 0)
        except ChildProcessError: pass
        code = "TIMEOUT"
    try:
        while True:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r: break
            c = os.read(fd, 4096)
            if not c: break
            out += c
    except OSError:
        pass
    os.close(fd)
    return out.decode(errors="replace"), code

out, code = run(spec["steps"], spec["gitcfg"])
json.dump({"out": out, "code": code}, sys.stdout)
`;

const drive = (steps, useGit) => {
  const raw = execFileSync(
    "python3",
    ["-c", DRIVER, JSON.stringify({ steps, gitcfg: useGit ? gitcfg : "/dev/null" })],
    { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname },
  );
  return JSON.parse(raw);
};

const assert = (cond, msg, extra = "") => {
  if (!cond) {
    console.error(`FAIL: ${msg}\n${extra.slice(-500)}`);
    process.exit(1);
  }
};

// Ctrl-C at the optional name prompt: abort, never provision.
let r = drive(
  [
    ["Email for this workspace", "real@x.dev\r"],
    ["Your name", ETX],
  ],
  false,
);
assert(r.code === 130, `Ctrl-C at name prompt should exit 130, got ${r.code}`, r.out);
assert(!r.out.includes("Couldn't reach"), "Ctrl-C must never reach the network", r.out);

// Backspace repairs the buffer; the question is not eaten (no bogus re-ask).
r = drive(
  [
    ["Email for this workspace", `@@${DEL}${DEL}real@x.dev\r`],
    ["Your name", "\r"],
  ],
  false,
);
assert(!r.out.includes("doesn't look like an email"), "backspaces must edit the input buffer", r.out);
assert(
  r.out.includes("Couldn't reach"),
  "the repaired value must proceed to the provision attempt",
  r.out,
);

// Ctrl-C at the git-identity confirm and at the email prompt: abort.
r = drive([["[Y/n]", ETX]], true);
assert(r.out.includes("Pty Probe <pty@probe.dev>"), "confirm prompt must show the git identity", r.out);
assert(r.code === 130, `Ctrl-C at confirm should exit 130, got ${r.code}`, r.out);
r = drive(
  [
    ["[Y/n]", "n\r"],
    ["Email for this workspace", ETX],
  ],
  true,
);
assert(r.code === 130, `Ctrl-C at email prompt should exit 130, got ${r.code}`, r.out);

console.log(
  "tty prompts: Ctrl-C aborts at every prompt (130, nothing sent); backspace edits without eating the question",
);
