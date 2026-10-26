#!/usr/bin/env node
// Статическая проверка исполнимости owner-документов M11 (A4 / Phase 6 / Full-Execution).
//
// Мотивация: девять дефектов исполнимости были найдены вручную повторными проходами.
// Этот скрипт делает ту же проверку детерминированной и дешёвой, чтобы её выполнял gate,
// а не человек. Он НЕ исполняет PowerShell (pwsh на сервере отсутствует) и не заменяет
// прогон на Windows; он ловит классы ошибок, которые до этого находились глазами:
//
//   1. несбалансированные ()/{}/[] и незакрытые кавычки/here-строки в блоках ```powershell;
//   2. символы '<'/'>' в исполняемом коде и в двойных кавычках (в PowerShell это
//      перенаправление, поэтому путь вида C:\<OWNED>\... падает);
//   3. evidence-ID, которые документ предписывает писать, уже заняты в evidence/m11-pilot
//      (запись поверх нарушила бы append-only);
//   4. заявленный «старт с NNNNNN» не равен фактическому максимуму + 1;
//   5. дубли и пропуски в таблице evidence-ID задания A4;
//   6. документ без ожидаемых исполняемых блоков (иначе «0 находок» = «нечего проверять»);
//   7. упоминание занятого evidence-ID без пометки «историч./занят/PASS» — кандидат на перезапись.
//
// Использование:
//   node scripts/m11/verify-owner-docs.mjs             # человекочитаемый отчёт, exit 0/1
//   node scripts/m11/verify-owner-docs.mjs --json      # машинный отчёт
//   node scripts/m11/verify-owner-docs.mjs --selftest  # проверка самого детектора (15 кейсов)
//
// Границы (важно): это НЕОБХОДИМОЕ, но НЕ достаточное условие исполнимости.
//   - синтаксис PowerShell проверяется эвристически (баланс разделителей, кавычки,
//     here-строки, подстановки $( )), а не парсером языка;
//   - семантика команд (существует ли cmdlet, допустимы ли аргументы, есть ли права)
//     здесь не проверяется и остаётся за прогоном на Windows;
//   - успех скрипта не заменяет owner-прогон и не является приёмкой A4/Phase 6.
// `--selftest` нужен потому, что «0 находок» у неработающего детектора выглядит
// так же, как у исправных документов.

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const defaultDocsDir = join(repoRoot, "docs", "omp-migration");
const evidenceDir = join(repoRoot, "evidence", "m11-pilot");

const DOCS = {
  a4: "M11_A4_TASK.md",
  phase6: "M11_PHASE6_TASK.md",
  full: "M11_FULL_EXECUTION_TASK.md",
  final: "M11_OWNER_FINAL.md",
};

let findings = [];
const addFinding = (rule, file, detail) => findings.push({ rule, file, detail });

// --- самопроверка детектора (--selftest) --------------------------------------
// Каждый кейс фиксирует поведение эвристики: без этого «0 находок» неотличимо
// от неработающего детектора.

function selfTest() {
  const cases = [
    { name: "balanced", code: 'if ($a) { Write-Output "x" }', wantBalance: 0, wantRedirect: 0 },
    { name: "unclosed-brace", code: "if ($a) { Write-Output 'x'", wantBalance: 1, wantRedirect: 0 },
    { name: "stray-close-paren", code: "Write-Output $a )", wantBalance: 1, wantRedirect: 0 },
    { name: "unclosed-double-quote", code: 'Write-Output "x', wantBalance: 1, wantRedirect: 0 },
    {
      name: "here-string-keeps-braces",
      code: "$t = @'\n{ unbalanced ( inside here-string\n'@\nWrite-Output $t",
      wantBalance: 0,
      wantRedirect: 0,
    },
    {
      name: "literal-parens-in-double-quote",
      code: 'Write-Output "exitCode=UNKNOWN (watchdog timeout, kill не завершил процесс)"',
      wantBalance: 0,
      wantRedirect: 0,
    },
    {
      name: "subexpression-in-double-quote",
      code: 'Write-Output "hasExited=$($p.HasExited); code=$($p.ExitCode)"',
      wantBalance: 0,
      wantRedirect: 0,
    },
    { name: "comment-with-brace", code: "# if ($a) {\nWrite-Output 1", wantBalance: 0, wantRedirect: 0 },
    { name: "single-quoted-placeholder-ok", code: "$owned = '<OWNED_DIR>'", wantBalance: 0, wantRedirect: 0 },
    { name: "double-quoted-redirect-char", code: '$p = "C:\\<OWNED>\\etw"', wantBalance: 0, wantRedirect: 2 },
    { name: "bare-redirect-char", code: "New-Item -Value <path>", wantBalance: 0, wantRedirect: 2 },
    { name: "escaped-quote-in-double", code: 'Write-Output "a `" b"', wantBalance: 0, wantRedirect: 0 },
    {
      name: "unbalanced-inside-subexpression",
      code: 'Write-Output "x=$($a -and ($b)"',
      // две находки: незакрытая '(' подстановки и незакрытая кавычка после неё
      wantBalance: 2,
      wantRedirect: 0,
    },
    {
      name: "nested-subexpression-balanced",
      code: 'Write-Output "x=$($a -and ($b -or $c))"',
      wantBalance: 0,
      wantRedirect: 0,
    },
    {
      name: "expandable-here-string-subexpression-balanced",
      code: '$t = @"\ntext $(if ($a) { 1 }) more\n"@\nWrite-Output $t',
      wantBalance: 0,
      wantRedirect: 0,
    },
    {
      name: "expandable-here-string-subexpression-unbalanced",
      code: '$t = @"\ntext $(if ($a) { 1\n"@',
      // каскад: незакрытая '{' подстановки + остаток строки разбирается как код
      wantBalance: 3,
      wantRedirect: 0,
    },
    {
      name: "literal-here-string-subexpression-is-text",
      code: "$t = @'\ntext $(if ($a) { 1\n'@\nWrite-Output $t",
      wantBalance: 0,
      wantRedirect: 0,
    },
    {
      name: "here-string-terminator-with-trailing-text",
      code: "$t = @'\ntext\n'@ trailing\nWrite-Output $t",
      wantBalance: 1,
      wantRedirect: 0,
    },
  ];
  let failures = 0;
  for (const c of cases) {
    const balance = scanPowerShell(c.code).length;
    const redirect = findRedirectChars(c.code).length;
    const ok = balance === c.wantBalance && redirect === c.wantRedirect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${c.name}: balance=${balance} (want ${c.wantBalance}), redirect=${redirect} (want ${c.wantRedirect})`,
    );
  }
  console.log(failures === 0 ? `selftest: OK (${cases.length} кейсов)` : `selftest: FAIL (${failures} из ${cases.length})`);
  return failures === 0 ? 0 : 1;
}

// --- извлечение fenced-блоков -------------------------------------------------

function extractPowerShellBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = null;
  lines.forEach((line, idx) => {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (current === null) {
        current = { lang: fence[1].toLowerCase(), startLine: idx + 1, lines: [] };
        return;
      }
      if (current.lang === "powershell" || current.lang === "ps1" || current.lang === "pwsh") {
        blocks.push({ ...current, endLine: idx + 1, body: current.lines.join("\n") });
      }
      current = null;
      return;
    }
    if (current) current.lines.push(line);
  });
  if (current && (current.lang === "powershell" || current.lang === "ps1" || current.lang === "pwsh")) {
    // незакрытый fence — сам по себе дефект документа
    addFinding(
      "unterminated-fence",
      null,
      `блок с fence «${current.lang}» со строки ${current.startLine} не закрыт`,
    );
  }
  return blocks;
}

// --- эвристический разбор PowerShell-кода -------------------------------------
// Один токенизатор на обе проверки: баланс разделителей и '<'/'>' в исполняемых
// местах. Два независимых сканера разошлись бы (именно это и было дефектом первой
// версии: here-строки обрабатывались только в одном из них).

function analyzePowerShell(body) {
  const balance = [];
  const redirect = [];
  const stack = [];
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const rev = { ")": "(", "}": "{", "]": "[" };
  const subStack = []; // откуда вернуться после закрытия $( ... )
  let state = "code"; // code | single | double | hereSingle | hereDouble | comment
  let line = 1;
  let hereQuote = null;

  const open = (ch) => stack.push({ ch, line });
  const close = (ch) => {
    const top = stack.pop();
    if (!top) {
      balance.push({ line, detail: `лишняя закрывающая скобка '${ch}'` });
      return;
    }
    if (top.ch !== rev[ch]) {
      balance.push({ line, detail: `'${ch}' закрывает '${top.ch}' со строки ${top.line}` });
    }
    // закрылась подстановка $( ... ) — вернуться в строку/here-строку, откуда её открыли
    while (subStack.length > 0 && stack.length === subStack[subStack.length - 1].depth) {
      state = subStack.pop().state;
    }
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const next = body[i + 1];

    if (state === "hereSingle" || state === "hereDouble") {
      // В expandable here-строке (@" ... "@) подстановки $( ... ) — это исполняемый код:
      // разбираем их как код, а литеральный текст оставляем текстом.
      if (state === "hereDouble" && ch === "$" && next === "(") {
        subStack.push({ state: "hereDouble", depth: stack.length });
        stack.push({ ch: "(", line });
        state = "code";
        i += 1;
        continue;
      }
      if (ch === "\n") {
        // Закрывающий маркер here-строки обязан стоять в начале строки
        // (столбец 0) и за ним не должно быть ничего, кроме пробелов.
        if (next === hereQuote && body[i + 2] === "@") {
          let k = i + 3;
          while (k < body.length && (body[k] === " " || body[k] === "\t")) k += 1;
          if (k >= body.length || body[k] === "\n" || body[k] === "\r") {
            state = "code";
            hereQuote = null;
            line += 1;
            i = k - 1;
            continue;
          }
        }
        line += 1;
      }
      continue;
    }

    if (ch === "\n") {
      line += 1;
      if (state === "comment") state = "code";
      continue;
    }

    if (state === "comment") continue;

    if (state === "single") {
      if (ch === "'") {
        if (next === "'") {
          i += 1; // экранированная кавычка ''
          continue;
        }
        state = "code";
      }
      continue;
    }

    if (state === "double") {
      if (ch === "`") {
        i += 1; // escape
        continue;
      }
      if (ch === "$" && next === "(") {
        // $( ... ) — это код внутри строки: разбираем его как код, иначе
        // несбалансированные скобки внутри подстановки проходят незамеченными.
        subStack.push({ state: "double", depth: stack.length });
        stack.push({ ch: "(", line });
        state = "code";
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = "code";
        continue;
      }
      if (ch === "<" || ch === ">") {
        redirect.push({ line, ch, where: "double-quoted" });
      }
      continue;
    }

    // state === "code"
    if (ch === "#") {
      state = "comment";
      continue;
    }
    if (ch === "`") {
      i += 1; // escape следующего символа (включая перевод строки)
      continue;
    }
    if (ch === "@" && (next === "'" || next === '"')) {
      // here-string начинается, только если @' / @" стоит в конце строки
      let j = i + 2;
      while (j < body.length && (body[j] === " " || body[j] === "\t")) j += 1;
      if (j >= body.length || body[j] === "\n") {
        state = next === "'" ? "hereSingle" : "hereDouble";
        hereQuote = next;
        i = j - 1;
        continue;
      }
    }
    if (ch === "'") {
      state = "single";
      continue;
    }
    if (ch === '"') {
      state = "double";
      continue;
    }
    if (pairs[ch]) {
      open(ch);
      continue;
    }
    if (rev[ch]) {
      close(ch);
      continue;
    }
    if (ch === "<" || ch === ">") redirect.push({ line, ch, where: "bare" });
  }

  if (state === "single") balance.push({ line, detail: "незакрытая одинарная кавычка" });
  if (state === "double") balance.push({ line, detail: "незакрытая двойная кавычка" });
  if (state === "hereSingle" || state === "hereDouble") {
    balance.push({ line, detail: "незакрытая here-строка (@' / @\")" });
  }
  for (const left of stack) balance.push({ line: left.line, detail: `незакрытая '${left.ch}'` });

  return { balance, redirect };
}

const scanPowerShell = (body) => analyzePowerShell(body).balance;
const findRedirectChars = (body) => analyzePowerShell(body).redirect;

// --- evidence ----------------------------------------------------------------

function listEvidenceIds() {
  const ids = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      // ID — ровно шесть цифр, отделённых от более длинных числовых последовательностей
      // (в именах есть даты вида 20261019 — они не evidence-ID).
      const m = name.match(/(?<!\d)(\d{6})(?!\d)/);
      if (m) ids.add(m[1]);
    }
  };
  walk(evidenceDir);
  return ids;
}

function tableIds(text, heading) {
  // строки таблицы вида: | 000256 | `file` | описание |
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const after = text.slice(start);
  const rows = [];
  for (const line of after.split(/\r?\n/)) {
    if (/^\s*##\s/.test(line) && rows.length > 0) break;
    const m = line.match(/^\|\s*(\d{6})\s*\|/);
    if (m) rows.push(m[1]);
  }
  return rows;
}

function maxEvidenceId(ids) {
  let max = null;
  for (const id of ids) if (max === null || Number(id) > Number(max)) max = id;
  return max;
}

// --- прогон ------------------------------------------------------------------
// analyze(dir) прогоняет все проверки по набору документов из каталога dir.
// findings модульный, поэтому сбрасывается на каждом входе; это позволяет
// использовать одну и ту же проверку и для текущего HEAD, и для исторических
// ревизий в режиме --history.

function analyze(docsDir) {
  findings = [];
  const results = [];
  const occupied = listEvidenceIds();

// Каждый документ обязан содержать свои исполняемые блоки: иначе «0 находок»
// означало бы «нечего проверять», а не «всё исполняется».
const EXPECTED_MIN_BLOCKS = { a4: 4, phase6: 2, full: 4 };

  for (const [key, name] of Object.entries(DOCS)) {
    const path = join(docsDir, name);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      addFinding("missing-doc", name, `не читается: ${err.message}`);
      continue;
    }
    const blocks = extractPowerShellBlocks(text);
    const blockProblems = [];
    const redirectProblems = [];
    for (const block of blocks) {
      for (const p of scanPowerShell(block.body)) {
        blockProblems.push({ blockStart: block.startLine, ...p });
      }
      for (const h of findRedirectChars(block.body)) {
        redirectProblems.push({ blockStart: block.startLine, ...h });
      }
    }
    for (const p of blockProblems) {
      addFinding(
        "powershell-balance",
        name,
        `блок с строки ${p.blockStart}, строка ${p.line}: ${p.detail}`,
      );
    }
    for (const h of redirectProblems) {
      addFinding(
        "powershell-redirect-char",
        name,
        `блок с строки ${h.blockStart}, строка ${h.line}: '${h.ch}' (${h.where}) — в PowerShell это перенаправление`,
      );
    }
    results.push({ doc: name, blocks: blocks.length });
    const min = EXPECTED_MIN_BLOCKS[key];
    if (typeof min === "number" && blocks.length < min) {
      addFinding(
        "doc-blocks-missing",
        name,
        `найдено ${blocks.length} PowerShell-блоков, ожидалось не меньше ${min}: документ изменился или разбор сломан`,
      );
    }
  }

// Занятый evidence-ID может упоминаться только как история. Строка, где занятый ID
// (или диапазон с занятым началом) подан без пометки, — это кандидат на перезапись.
const OCCUPIED_MARKERS = [
  "занят",
  "ЗАНЯТ",
  "историч",
  "ИСТОРИЧ",
  "не исполнять",
  "НЕ ИСПОЛНЯТЬ",
  "выполнено",
  "ВЫПОЛНЕНО",
  "PASS",
  "принят",
  "ПРИНЯТ",
  "максимум",
  "МАКСИМУМ",
];
for (const name of Object.values(DOCS)) {
  const path = join(docsDir, name);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  let contextMarked = false; // пометка в заголовке/врезке покрывает таблицу под ней
  text.split(/\r?\n/).forEach((line, idx) => {
    const isHeading = /^\s*#{2,4}\s/.test(line) || /^\s*>/.test(line);
    if (isHeading) {
      contextMarked = OCCUPIED_MARKERS.some((marker) => line.includes(marker));
    }
    const ids = [...line.matchAll(/(?<!\d)(\d{6})(?!\d)/g)].map((m) => m[1]);
    const occupiedHere = ids.filter((id) => occupied.has(id));
    if (occupiedHere.length === 0) return;
    if (contextMarked) return;
    if (OCCUPIED_MARKERS.some((marker) => line.includes(marker))) return;
    addFinding(
      "occupied-id-unmarked",
      name,
      `строка ${idx + 1} упоминает занятый ID ${occupiedHere[0]} без пометки «историч./занят/PASS»: возможна перезапись`,
    );
  });
}

// A4: таблица evidence-ID
let a4Text = null;
try {
  a4Text = readFileSync(join(docsDir, DOCS.a4), "utf8");
} catch {
  a4Text = null;
}
if (a4Text !== null) {
  const a4Ids = tableIds(a4Text, "## 9. Evidence-контракт");
  const a4Declared = a4Text.match(/старт с (\d{6})/);
  if (!a4Ids) {
    addFinding("a4-evidence-table", DOCS.a4, "не найдена таблица §9 Evidence-контракт");
  } else if (a4Ids.length === 0) {
    addFinding("a4-evidence-table-empty", DOCS.a4, "таблица §9 не содержит строк с ID");
  } else {
    if (!a4Declared) {
      addFinding(
        "a4-evidence-start-missing",
        DOCS.a4,
        "нет объявления «старт с NNNNNN»: граница append-only не зафиксирована",
      );
    }
    if (new Set(a4Ids).size !== a4Ids.length) {
      addFinding("a4-evidence-duplicate", DOCS.a4, "в §9 повторяются ID");
    }
    const sorted = [...a4Ids].map(Number).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        addFinding(
          "a4-evidence-gap",
          DOCS.a4,
          `разрыв в нумерации: ${String(sorted[i - 1]).padStart(6, "0")} → ${String(sorted[i]).padStart(6, "0")}`,
        );
      }
    }
    for (const id of a4Ids) {
      if (occupied.has(id)) {
        addFinding(
          "a4-evidence-collision",
          DOCS.a4,
          `ID ${id} предписан к записи, но уже занят в evidence/m11-pilot`,
        );
      }
    }
    const declared = a4Declared;
    const max = maxEvidenceId(occupied);
    const expected = max === null ? null : String(Number(max) + 1).padStart(6, "0");
    if (declared && expected && declared[1] !== expected) {
      addFinding(
        "a4-evidence-start-stale",
        DOCS.a4,
        `документ объявляет старт с ${declared[1]}, фактический максимум+1 = ${expected}`,
      );
    }
    if (declared && sorted[0] !== Number(declared[1])) {
      addFinding(
        "a4-evidence-start-mismatch",
        DOCS.a4,
        `таблица начинается с ${String(sorted[0]).padStart(6, "0")}, а текст объявляет ${declared[1]}`,
      );
    }
  }
}

// Phase 6: не должно быть жёстких «продолжаем с 0002NN», если такой диапазон занят
let ph6Text = null;
try {
  ph6Text = readFileSync(join(docsDir, DOCS.phase6), "utf8");
} catch {
  ph6Text = null;
}
if (ph6Text !== null) {
  const ph6Hard = [...ph6Text.matchAll(/\b(\d{6})\s*[–-]\s*(\d{6})\b/g)].map((m) => m[1]);
  for (const id of ph6Hard) {
    if (occupied.has(id)) {
      addFinding(
        "phase6-evidence-collision",
        DOCS.phase6,
        `жёсткий диапазон начинается с занятого ID ${id}`,
      );
    }
  }

  // Phase 6: диапазон-заглушка next+1 … next+K должен быть непрерывным и без дублей
  const ph6Section = ph6Text.slice(ph6Text.indexOf("## 6. Evidence-контракт"));
  const ph6Next = [...ph6Section.matchAll(/next\+(\d+)/g)].map((m) => Number(m[1]));
  if (ph6Next.length === 0) {
    addFinding(
      "phase6-next-missing",
      DOCS.phase6,
      "в §6 нет плейсхолдеров next+N: граница нумерации не зафиксирована",
    );
  } else {
    const unique = [...new Set(ph6Next)].sort((a, b) => a - b);
    if (unique.length !== ph6Next.length) {
      addFinding("phase6-next-duplicate", DOCS.phase6, "в §6 повторяются плейсхолдеры next+N");
    }
    for (let i = 0; i < unique.length; i += 1) {
      if (unique[i] !== i + 1) {
        addFinding(
          "phase6-next-gap",
          DOCS.phase6,
          `плейсхолдеры next+N не непрерывны: ожидался next+${i + 1}, найден next+${unique[i]}`,
        );
        break;
      }
    }
  }
}

  return { results, findings, occupied };
}

// --- проверка на реальной истории ---------------------------------------------
// «0 находок» на HEAD ничего не доказывает, если детектор не способен поймать уже
// известные дефекты. Каждая ревизия здесь — реальный коммит до исправления;
// ожидается, что проверка на нём падает и содержит указанные правила.

const HISTORY_CASES = [
  {
    rev: "f79908a",
    note: "буквальные C:\\<OWNED> в путях: PowerShell читает '<'/'>' как перенаправление",
    expect: ["powershell-redirect-char"],
    docs: ["M11_A4_TASK.md", "M11_PHASE6_TASK.md", "M11_FULL_EXECUTION_TASK.md"],
  },
  {
    rev: "27d1459",
    note: "Full-Execution предписывает evidence 000159+ при фактическом максимуме 000255",
    expect: ["occupied-id-unmarked"],
    docs: ["M11_A4_TASK.md", "M11_PHASE6_TASK.md", "M11_FULL_EXECUTION_TASK.md"],
  },
];

function revExists(rev) {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${rev}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isShallow() {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function materialize(rev, dir) {
  const used = [];
  const failed = [];
  for (const name of Object.values(DOCS)) {
    const spec = `${rev}:docs/omp-migration/${name}`;
    // Документа может не быть в старой ревизии — это не дефект. Ошибка чтения
    // существующего файла — дефект окружения, и её нельзя глушить: иначе кейс
    // «поймал дефект» может пройти на одном файле из трёх.
    let exists = false;
    try {
      execFileSync("git", ["-C", repoRoot, "cat-file", "-e", spec], { stdio: "ignore" });
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) continue;
    try {
      const text = execFileSync("git", ["-C", repoRoot, "show", spec], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      writeFileSync(join(dir, name), text);
      used.push(name);
    } catch (err) {
      failed.push(`${name}: ${err.message.split("\n")[0]}`);
    }
  }
  return { used, failed };
}

function history() {
  let failures = 0;
  let skipped = 0;
  const shallow = isShallow();
  // Пропуск допустим только явным флагом. Иначе shallow-клон давал бы зелёный
  // результат без единой проверки детектора на известных дефектах.
  const allowSkip = process.argv.includes("--allow-shallow-skip");
  for (const c of HISTORY_CASES) {
    if (!revExists(c.rev)) {
      if (shallow && allowSkip) {
        skipped += 1;
        console.log(`SKIP ${c.rev}: нет в shallow-клоне (--allow-shallow-skip)`);
        continue;
      }
      failures += 1;
      console.log(
        `FAIL ${c.rev}: ревизия отсутствует${shallow ? " (shallow-клон; нужен полный клон или --allow-shallow-skip)" : ""} — ${c.note}`,
      );
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), "m11-owner-docs-"));
    try {
      const { used, failed } = materialize(c.rev, dir);
      if (failed.length > 0) {
        failures += 1;
        console.log(`FAIL ${c.rev}: git show упал на ${failed.join("; ")} — ${c.note}`);
        continue;
      }
      const missingDocs = c.docs.filter((d) => !used.includes(d));
      if (missingDocs.length > 0) {
        failures += 1;
        console.log(
          `FAIL ${c.rev}: в ревизии нет ожидаемых документов ${missingDocs.join(", ")} — ${c.note}`,
        );
        continue;
      }
      const { findings: f } = analyze(dir);
      const rules = new Set(f.map((x) => x.rule));
      const missing = c.expect.filter((r) => !rules.has(r));
      const caught = c.expect.every((r) => rules.has(r));
      if (!caught) failures += 1;
      console.log(
        `${caught ? "ok  " : "FAIL"} ${c.rev}: ${f.length} находок${caught ? "" : `, не поймано: ${missing.join(", ")}`} — ${c.note}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const head = analyze(defaultDocsDir);
  const headClean = head.findings.length === 0;
  if (!headClean) failures += 1;
  console.log(
    `${headClean ? "ok  " : "FAIL"} HEAD: ${head.findings.length} находок (ожидалось 0)`,
  );
  const total = HISTORY_CASES.length + 1 - skipped;
  console.log(
    failures === 0
      ? `history: OK (${total} проверок${skipped ? `, ${skipped} пропущено из-за shallow-клона` : ""})`
      : `history: FAIL (${failures} из ${total})`,
  );
  return failures === 0 ? 0 : 1;
}

// --- точка входа ---------------------------------------------------------------

if (process.argv.includes("--selftest")) process.exit(selfTest());

const docsArgIndex = process.argv.indexOf("--docs");
let docsOverride = null;
if (docsArgIndex >= 0) {
  const value = process.argv[docsArgIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("verify-owner-docs: --docs требует путь к каталогу с документами");
    process.exit(2);
  }
  docsOverride = resolve(value);
}

if (process.argv.includes("--history")) {
  if (docsOverride) {
    // --history проверяет исторические ревизии и HEAD репозитория; подмена каталога
    // сделала бы проверку HEAD бессмысленной, поэтому комбинация запрещена явно.
    console.error("verify-owner-docs: --history несовместим с --docs");
    process.exit(2);
  }
  process.exit(history());
}

const docsDir = docsOverride ?? defaultDocsDir;

const { results, findings: found, occupied } = analyze(docsDir);

const report = {
  ok: found.length === 0,
  docsDir,
  evidence: { occupiedCount: occupied.size, max: maxEvidenceId(occupied) },
  docs: results,
  findings: found,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (report.ok) {
  console.log(
    `verify-owner-docs: OK (${results.length} документа, ${results.reduce((n, r) => n + r.blocks, 0)} PowerShell-блоков, evidence max ${report.evidence.max})`,
  );
} else {
  console.log(`verify-owner-docs: FAIL (${found.length} находок)`);
  for (const f of found) console.log(`- [${f.rule}] ${f.file ?? ""}: ${f.detail}`);
}

process.exit(report.ok ? 0 : 1);
