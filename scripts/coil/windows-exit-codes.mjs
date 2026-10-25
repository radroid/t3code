/*
 * Names a Windows fatal exit status and decides whether a retry is worth it. vp prints the signed
 * 32-bit decimal (`-1073741502`, not `0xC0000142`), so every spelling is matched: a hex-only grep
 * never fires. Startup-pressure statuses retry; self-corruption ones fail fast. `.mjs` because the
 * workflow runs it on the runner image's Node with no `setup-node` step.
 */

/**
 * `signed` is the value as Node reports it; `transient` means another attempt is reasonable.
 * @typedef {{ name: string, unsigned: number, signed: number, transient: boolean,
 *   meaning: string, advice: string }} WindowsStatus
 */

/** @type {readonly WindowsStatus[]} */
export const WINDOWS_FATAL_STATUSES = [
  {
    name: "STATUS_DLL_INIT_FAILED",
    unsigned: 0xc0000142,
    signed: -1073741502,
    transient: true,
    meaning:
      "A DLL's initialisation routine failed while the process was starting, so the program never reached main().",
    advice:
      "Usually desktop-heap or session resource pressure from spawning several processes at once. Retry, and prefer serialising the build over widening the pool.",
  },
  {
    name: "STATUS_ACCESS_VIOLATION",
    unsigned: 0xc0000005,
    signed: -1073741819,
    transient: true,
    meaning: "The process read or wrote memory it does not own — a segfault, in Unix terms.",
    advice:
      "The weakest member of this table: it is a genuine crash, and it is only treated as retryable because it also shows up under the same concurrent-spawn pressure as STATUS_DLL_INIT_FAILED. If it recurs on retry, stop treating it as flaky.",
  },
  {
    name: "STATUS_DLL_NOT_FOUND",
    unsigned: 0xc0000135,
    signed: -1073741515,
    transient: false,
    meaning: "A DLL the program links against is not on the search path.",
    advice:
      "Deterministic, so retrying cannot help. Usually a missing Visual C++ redistributable or a toolchain step that did not run.",
  },
  {
    name: "STATUS_INVALID_IMAGE_FORMAT",
    unsigned: 0xc000007b,
    signed: -1073741701,
    transient: false,
    meaning:
      "An executable or DLL is the wrong architecture — a 32-bit image loaded into a 64-bit process, or the reverse.",
    advice: "Deterministic. Check which arch the failing dependency was built for.",
  },
  {
    name: "STATUS_HEAP_CORRUPTION",
    unsigned: 0xc0000374,
    signed: -1073740940,
    transient: false,
    meaning: "The process corrupted its own heap and Windows killed it.",
    advice:
      "A real bug, not resource pressure. Do not retry; capture the failing step and report it.",
  },
  {
    name: "STATUS_STACK_BUFFER_OVERRUN",
    unsigned: 0xc0000409,
    signed: -1073740791,
    transient: false,
    meaning:
      "A stack buffer was overrun and the security cookie check aborted the process. Also what Windows reports for a fail-fast abort.",
    advice: "A real bug. Do not retry.",
  },
];

/**
 * Looks a status up by any of the spellings that appear in real logs: the signed decimal Node
 * reports, the unsigned decimal, the hex form, or the NTSTATUS name.
 *
 * @param {number | string} code
 * @returns {WindowsStatus | undefined}
 */
export function describeWindowsExitCode(code) {
  if (typeof code === "number") {
    return WINDOWS_FATAL_STATUSES.find((s) => s.signed === code || s.unsigned === code);
  }
  const token = String(code).trim();
  const numeric = /^-?\d+$/u.test(token)
    ? Number(token)
    : /^0x[0-9a-f]+$/iu.test(token)
      ? Number.parseInt(token, 16)
      : undefined;
  if (numeric !== undefined) return describeWindowsExitCode(numeric);
  return WINDOWS_FATAL_STATUSES.find((s) => s.name.toLowerCase() === token.toLowerCase());
}

/**
 * Every status named anywhere in a build log, in table order. Matches every spelling, since vp
 * prints signed decimal, Windows dialogs print hex and crash dumps print the name.
 * @param {string} logText
 * @returns {readonly WindowsStatus[]}
 */
export function findWindowsFatalStatuses(logText) {
  const text = String(logText ?? "");
  return WINDOWS_FATAL_STATUSES.filter((status) => {
    const hex = status.unsigned.toString(16);
    const patterns = [
      // `\b` is wrong at both ends here. The leading `-` of the signed form is a non-word
      // character, so `\b-1073741502` never matches after `code: `; and a trailing `\b` would
      // still match inside `-10737415021`. Hence explicit "no digit or minus before, no digit
      // after", which is what stops a build id from being read as a crash.
      new RegExp(`(?<![\\d-])${status.signed}(?!\\d)`, "u"),
      new RegExp(`(?<![\\d-])${status.unsigned}(?!\\d)`, "u"),
      new RegExp(`0x0*${hex}\\b`, "iu"),
      new RegExp(`\\b${status.name}\\b`, "iu"),
    ];
    return patterns.some((pattern) => pattern.test(text));
  });
}

/**
 * True when every fatal status in the log is one worth retrying, and there is at least one.
 *
 * "Every", not "any": a log carrying both a heap corruption and a DLL-init failure is not a flaky
 * build, and retrying it would hide the corruption behind two more minutes of compute.
 *
 * @param {string} logText
 */
export function isTransientProcessStartFailure(logText) {
  const found = findWindowsFatalStatuses(logText);
  return found.length > 0 && found.every((status) => status.transient);
}

/**
 * The human-readable report. Written for whoever is reading a failed CI run at the point where
 * the only other evidence is a negative integer.
 *
 * @param {string} logText
 */
export function explainWindowsFailure(logText) {
  const found = findWindowsFatalStatuses(logText);
  if (found.length === 0) return "";

  const lines = [];
  for (const status of found) {
    lines.push(
      `${status.name} (0x${status.unsigned.toString(16).toUpperCase()}, reported by Node as ${status.signed})`,
      `  What it means: ${status.meaning}`,
      `  ${status.transient ? "Retryable" : "NOT retryable"}: ${status.advice}`,
    );
  }
  return lines.join("\n");
}

// CLI: `node scripts/coil/windows-exit-codes.mjs --classify <logfile>`
//
// Prints the explanation, then exits 0 when a retry is warranted and 1 when it is not — so the
// caller can write `if node … --classify "$log"; then retry; fi` without parsing anything.
if (
  process.argv[1] &&
  process.argv[1].endsWith("windows-exit-codes.mjs") &&
  process.argv.includes("--classify")
) {
  const { readFileSync } = await import("node:fs");
  const file = process.argv[process.argv.indexOf("--classify") + 1];
  if (!file) {
    console.error("usage: windows-exit-codes.mjs --classify <logfile>");
    process.exit(2);
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`Could not read ${file}: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const explanation = explainWindowsFailure(text);
  if (explanation) console.error(explanation);
  else console.error("No known Windows fatal status appears in this log.");
  process.exit(isTransientProcessStartFailure(text) ? 0 : 1);
}
