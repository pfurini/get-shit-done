#!/usr/bin/env node
/**
 * Build a printable HELP.pdf from HELP.md.
 *
 *   Part 1 — Quick operational reference (printable on its own):
 *     mental model, 5 mermaid workflow diagrams (one per A4 page,
 *     auto-rotated to landscape for LR layouts), rules of thumb,
 *     adversarial gates compact view, namespace routers, flag cheat sheet.
 *   Part 2 — Detailed reference: standalone commands table + every
 *     sub-table from HELP.md §8 + full §10 conventions, behind a hard break.
 *
 * Pipeline: HELP.md → extract mermaid blocks → mmdc → SVG → assemble HTML
 * with @page CSS rules → chromium --headless --print-to-pdf → HELP.pdf.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'HELP.md');
const OUT_PDF = path.join(ROOT, 'HELP.pdf');
const BUILD_DIR = path.join(ROOT, 'build', 'help-pdf');
const HTML_PATH = path.join(BUILD_DIR, 'help.html');

// -------- utility ----------------------------------------------------------

function log(msg) {
  process.stderr.write(`[help-pdf] ${msg}\n`);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// -------- step 1: read source, extract mermaid blocks ---------------------

function extractMermaidBlocks(md) {
  const blocks = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push({ source: m[1].trimEnd(), start: m.index, end: re.lastIndex });
  }
  return blocks;
}

/**
 * Mermaid v11 in mmdc parses shape labels more strictly than GitHub's
 * renderer: unquoted parens inside `{...}` (diamond) or `[...]` (rect)
 * labels cause "Expecting 'SQE'..." parse errors. Wrap any such label in
 * quotes so v11 accepts it without breaking GitHub rendering of the source.
 */
function fixMermaidLabels(src) {
  let s = src;
  // {label} — diamond
  s = s.replace(/\{([^"{}][^{}]*)\}(?!\})/g, (m, inner) => {
    if (/[()]/.test(inner)) return `{"${inner.replace(/"/g, '\\"')}"}`;
    return m;
  });
  // [label] — rect (skip multi-char openers [[, [(, [/, [\)
  s = s.replace(/(?<![\[(/\\])\[([^"\[\]/\\(][^\[\]]*)\](?!\])/g, (m, inner) => {
    if (/[()]/.test(inner)) return `["${inner.replace(/"/g, '\\"')}"]`;
    return m;
  });
  return s;
}

/**
 * Force TD/TB flowcharts to LR so the rendered SVG is wider-than-tall and
 * fits an A4 landscape page legibly. Diagrams with many sequential ranks
 * (like the per-phase loop) are unreadable at portrait scale.
 */
function forceLayoutLR(src) {
  return src.replace(/^(\s*)flowchart\s+(TD|TB|BT)\b/m, '$1flowchart LR');
}

// -------- step 2: pre-render mermaid via mmdc ------------------------------

// Diagram 2 in HELP.md has 33 nodes — too dense to fit a single A4 page
// legibly. We split it at the `execute-phase` boundary into two hand-authored
// sub-diagrams so each lands on its own A4 page with ~8–10pt text. Edges and
// nodes mirror the original; any change to the upstream diagram must be
// reflected here too.

const DIAGRAM_2A_SOURCE = `flowchart LR
    classDef opt stroke-dasharray: 5 5,stroke:#666
    classDef gate fill:#ffd,stroke:#aa3

    P0[/"phase N pending<br/>in ROADMAP.md"/] --> SP["/gsd-spec-phase N<br/>SPEC.md (WHAT)"]:::opt
    SP --> DP["/gsd-discuss-phase N<br/>CONTEXT.md (HOW)"]
    P0 --> DP

    DP -- "frontend?" --> UI["/gsd-ui-phase N<br/>UI-SPEC.md"]:::opt
    DP -- "AI/LLM phase?" --> AI["/gsd-ai-integration-phase N<br/>AI-SPEC.md"]:::opt
    DP -- "vertical slice?" --> MVP["/gsd-mvp-phase N<br/>Mode: mvp"]:::opt
    DP --> PL["/gsd-plan-phase N"]
    UI --> PL
    AI --> PL
    MVP --> PL

    PL -- "research<br/>(Nyquist)" --> RES[("RESEARCH.md<br/>VALIDATION.md<br/>= test contract")]
    PL -- "plan<br/>(each task has<br/>&lt;verify&gt; block)" --> PLM[("NN-MM-PLAN.md<br/>files")]
    PL -- "verify" --> PLG{"plan-checker passes?<br/>(8th dim: every task<br/>has automated verify)"}:::gate
    PLG -- "no" --> PL
    PLG -- "yes" --> ALT{"Want peer<br/>review?"}:::gate

    ALT -- "no" --> EX["/gsd-execute-phase N<br/>→ continues on diagram 2b"]
    ALT -- "one shot" --> REV["/gsd-review --phase N --all"]:::opt
    REV --> RPL["/gsd-plan-phase N --reviews"]:::opt
    RPL --> EX
    ALT -- "loop until no HIGH" --> CONV["/gsd-plan-review-convergence N"]:::opt
    CONV --> EX
    ALT -- "offload to cloud" --> UP["/gsd-ultraplan-phase N"]:::opt
    UP --> EX
`;

const DIAGRAM_2B_SOURCE = `flowchart LR
    classDef opt stroke-dasharray: 5 5,stroke:#666
    classDef gate fill:#ffd,stroke:#aa3
    classDef rem fill:#fdd,stroke:#a33

    EX["/gsd-execute-phase N<br/>← from diagram 2a"]
    EX -- "wave 1 (parallel)<br/>tests + impl,<br/>atomic commits" --> S1[("NN-MM-SUMMARY.md<br/>per plan")]
    EX -- "wave 2 ..." --> S1
    EX -- "post-execute<br/>verifier" --> V1[("NN-VERIFICATION.md")]

    V1 --> CR["/gsd-code-review N<br/>--depth=quick|standard|deep"]:::opt
    V1 --> VW["/gsd-verify-work N<br/>(conversational UAT)"]
    CR -- "Critical /<br/>Warning?" --> CRF["/gsd-code-review --fix --auto"]:::rem
    CRF --> VW
    CR --> VW

    VW --> VWG{"All UAT<br/>pass?"}:::gate
    VWG -- "no, diagnosed" --> EX
    VWG -- "yes, want<br/>more tests" --> ADD["/gsd-add-tests N<br/>(SUPPLEMENT only)"]:::opt
    ADD --> SECG
    VWG -- "yes" --> SECG{"workflow.<br/>security_enforcement<br/>= true ?"}:::gate

    SECG -- "yes &amp; threats &gt; 0" --> SEC["/gsd-secure-phase N<br/>(REQUIRED before ship —<br/>blocks phase transition)"]
    SEC --> SECF{"threats_open<br/>= 0 ?"}:::gate
    SECF -- "no, remediate" --> EX
    SECF -- "yes" --> SHIP["/gsd-ship N<br/>(push branch, open PR)"]
    SECG -- "no OR threats = 0" --> SHIP

    SHIP --> POST{"Retroactive<br/>audits?"}:::gate
    POST -- "frontend" --> URV["/gsd-ui-review N"]:::opt
    POST -- "AI / eval" --> ERV["/gsd-eval-review N"]:::opt
    POST -- "coverage" --> VAL["/gsd-validate-phase N"]:::opt
    POST -- "security<br/>follow-up" --> SEC2["/gsd-secure-phase N<br/>(if gate was off)"]:::opt
    POST -- "learnings" --> LRN["/gsd-extract-learnings N"]:::opt
    SHIP --> NEXT[/"phase N+1"/]
    URV --> NEXT
    ERV --> NEXT
    SEC2 --> NEXT
    VAL --> NEXT
    LRN --> NEXT
`;

/**
 * Per-output-page render config.
 *   source:   index into the mermaid blocks extracted from HELP.md.
 *   override: replace the source with a hand-authored mermaid script.
 *   title:    headline shown at the top of the page (overrides default).
 *   layout:   'LR' to rewrite TD→LR; null keeps native direction.
 *   page:     'landscape' or 'portrait'.
 *
 * Diagram 2 (per-phase loop) is split at the execute-phase boundary into 2a
 * and 2b so each lands on its own A4 page with readable text.
 * Diagram 5 (artifact graph) stays in its native LR; mermaid stacks its
 * subgraphs vertically anyway, so portrait fits the aspect ratio better.
 */
const PAGES = [
  { source: 0, layout: 'LR', page: 'landscape',
    title: 'Diagram 1 — Full project lifecycle' },
  { source: 1, layout: null, page: 'landscape', override: DIAGRAM_2A_SOURCE,
    title: 'Diagram 2a — Main phase loop · plan side (spec → discuss → plan → execute)' },
  { source: 1, layout: null, page: 'landscape', override: DIAGRAM_2B_SOURCE,
    title: 'Diagram 2b — Main phase loop · verify & ship side (execute → UAT → security → ship)' },
  { source: 2, layout: null, page: 'landscape',
    title: 'Diagram 3 — Side workflows · remediation, parallel, retroactive' },
  { source: 3, layout: 'LR', page: 'landscape',
    title: 'Diagram 4 — Autonomous shortcuts' },
  { source: 4, layout: null, page: 'portrait',
    title: 'Diagram 5 — Artifact graph · who writes what, who reads what' },
];

function renderMermaid(blocks) {
  ensureDir(BUILD_DIR);
  const pages = [];
  // Mermaid config: bigger font + tighter spacing → wider, denser graph
  // that survives CSS scale-to-fit while keeping text legible.
  const cfgPath = path.join(BUILD_DIR, 'mermaid-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    theme: 'default',
    flowchart: {
      htmlLabels: true,
      useMaxWidth: true,
      curve: 'basis',
      nodeSpacing: 40,
      rankSpacing: 55,
      padding: 8,
    },
    themeVariables: {
      fontSize: '22px',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    },
  }, null, 2));

  for (let i = 0; i < PAGES.length; i++) {
    const cfg = PAGES[i];
    const slug = cfg.title.split(' —')[0].replace(/\s+/g, '-').toLowerCase();
    const mmd = path.join(BUILD_DIR, `page-${i + 1}-${slug}.mmd`);
    const svg = path.join(BUILD_DIR, `page-${i + 1}-${slug}.svg`);
    const rawSource = cfg.override !== undefined ? cfg.override : blocks[cfg.source].source;
    let prepared = fixMermaidLabels(rawSource);
    if (cfg.layout === 'LR') prepared = forceLayoutLR(prepared);
    fs.writeFileSync(mmd, prepared);
    log(`rendering ${slug} (layout=${cfg.layout || 'native'}, page=${cfg.page})`);
    execFileSync('npx', [
      '-y', '-p', '@mermaid-js/mermaid-cli@^11',
      'mmdc',
      '-i', mmd,
      '-o', svg,
      '-c', cfgPath,
      '-b', 'transparent',
      '--scale', '2',
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    pages.push({
      title: cfg.title,
      orientation: cfg.page,
      svg: fs.readFileSync(svg, 'utf8'),
    });
  }
  return pages;
}

// -------- step 3: minimal markdown → HTML for our specific content --------

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(text) {
  let s = escapeHtml(text);
  // code spans first, so we don't process markdown inside them
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold then italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // line break: trailing two spaces or explicit <br/>
  return s;
}

/**
 * Render a markdown subset: H2/H3/H4, paragraphs, bullets, ordered lists,
 * tables, blockquotes, fenced code, horizontal rules. NOT mermaid (we strip
 * those earlier).
 */
function renderMarkdown(md) {
  const lines = md.split('\n');
  let out = '';
  let i = 0;

  function flushPara(buf) {
    if (buf.length === 0) return;
    const text = buf.join(' ').trim();
    if (text) out += `<p>${renderInline(text)}</p>\n`;
  }

  while (i < lines.length) {
    const ln = lines[i];

    // fenced code
    if (/^```/.test(ln)) {
      const lang = ln.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // closing fence
      out += `<pre class="code"><code class="lang-${escapeHtml(lang)}">${escapeHtml(body.join('\n'))}</code></pre>\n`;
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(ln)) { out += '<hr/>\n'; i++; continue; }

    // headings
    let mh;
    if ((mh = ln.match(/^(#{2,4})\s+(.+?)\s*$/))) {
      const level = mh[1].length;
      out += `<h${level}>${renderInline(mh[2])}</h${level}>\n`;
      i++; continue;
    }

    // blockquote
    if (/^>\s?/.test(ln)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out += `<blockquote>${renderInline(body.join(' '))}</blockquote>\n`;
      continue;
    }

    // tables: header row | header |, separator | --- |
    if (/^\|.+\|\s*$/.test(ln) && i + 1 < lines.length && /^\|\s*[-:]+/.test(lines[i + 1])) {
      const header = ln.trim().slice(1, -1).split('|').map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      let t = '<table><thead><tr>';
      for (const h of header) t += `<th>${renderInline(h)}</th>`;
      t += '</tr></thead><tbody>';
      for (const r of rows) {
        t += '<tr>';
        for (let k = 0; k < header.length; k++) t += `<td>${renderInline(r[k] || '')}</td>`;
        t += '</tr>';
      }
      t += '</tbody></table>\n';
      out += t;
      continue;
    }

    // bullet list (- or *), possibly with one level of nested - (we keep flat)
    if (/^[-*]\s+/.test(ln)) {
      out += '<ul>';
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        // gather continuation lines (indented or non-bullet)
        const main = lines[i].replace(/^[-*]\s+/, '');
        const buf = [main];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !/^[-*]\s+/.test(lines[i]) &&
          !/^\d+\.\s+/.test(lines[i]) &&
          !/^#{2,4}\s/.test(lines[i]) &&
          !/^```/.test(lines[i])
        ) {
          buf.push(lines[i].trim());
          i++;
        }
        out += `<li>${renderInline(buf.join(' '))}</li>`;
      }
      out += '</ul>\n';
      continue;
    }

    // numbered list
    if (/^\d+\.\s+/.test(ln)) {
      out += '<ol>';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const main = lines[i].replace(/^\d+\.\s+/, '');
        const buf = [main];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !/^[-*]\s+/.test(lines[i]) &&
          !/^\d+\.\s+/.test(lines[i]) &&
          !/^#{2,4}\s/.test(lines[i]) &&
          !/^```/.test(lines[i])
        ) {
          buf.push(lines[i].trim());
          i++;
        }
        out += `<li>${renderInline(buf.join(' '))}</li>`;
      }
      out += '</ol>\n';
      continue;
    }

    // blank line
    if (ln.trim() === '') { i++; continue; }

    // default: paragraph (gather until blank line)
    const buf = [ln];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{2,4}\s/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^\|.+\|\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    flushPara(buf);
  }
  return out;
}

// -------- step 4: slice HELP.md by heading -------------------------------

function sliceSections(md) {
  // returns map of "1. Title" → content (without the heading line)
  const sections = {};
  const lines = md.split('\n');
  let current = null;
  let buf = [];
  for (const ln of lines) {
    const m = ln.match(/^##\s+(\d+)\.\s+(.+?)\s*$/);
    if (m) {
      if (current) sections[current] = buf.join('\n').trim();
      current = `${m[1]}. ${m[2]}`;
      buf = [];
    } else if (current) {
      buf.push(ln);
    }
  }
  if (current) sections[current] = buf.join('\n').trim();
  return sections;
}

// strip the mermaid fenced block from a section body
function stripMermaid(text) {
  return text.replace(/```mermaid\n[\s\S]*?```\n?/g, '').trim();
}

// -------- step 5: assemble HTML --------------------------------------------

function buildHtml({ sections, pages }) {
  // Section 1 — mental model (compact, lives on cover page)
  const s1 = sections['1. Mental model in 60 seconds'] || '';
  // Section 3 prose after the mermaid block — rules of thumb, audit gates,
  // adversarial reviews, when-tests-get-written. We dump it on its own page.
  const s3Rules = stripMermaid(sections['3. Diagram — main phase loop (per-phase, every optional gate)'] || '');
  // Section 9 — namespace routers (compact table)
  const s9 = sections['9. Namespace routers (one of six)'] || '';
  // Section 10 — argument conventions
  const s10 = sections['10. Argument & flag conventions'] || '';
  // Section 7 — standalone commands big table
  const s7 = sections['7. Standalone commands (run anytime, no milestone needed)'] || '';
  // Section 8 — full command reference (every subtable)
  const s8 = sections['8. Full command reference (every command, every flag)'] || '';

  function diagramPage(idx) {
    const p = pages[idx];
    const cls = p.orientation === 'landscape' ? 'diagram-page landscape' : 'diagram-page portrait';
    return `
<section class="${cls}">
  <header class="page-head">
    <span class="part-label">Part 1 · Workflows</span>
    <h2>${escapeHtml(p.title)}</h2>
  </header>
  <div class="diagram-frame">${p.svg}</div>
</section>`;
  }

  // Cheat sheet: distil the most-used flag conventions to ~6 bullets.
  const cheatSheet = `
<ul class="cheat-sheet">
  <li><code>--auto</code> — accept the model's recommended defaults at every gate (new-project, discuss-phase, plan-phase, spec-phase).</li>
  <li><code>--text</code> — plain-text numbered lists instead of TUI menus. Use on <code>/rc</code> remote sessions and non-Claude runtimes.</li>
  <li><code>--chain</code> — auto-chain to next workflow step (currently only <code>discuss-phase → plan-phase</code>).</li>
  <li><code>--reviews</code> — replan applying <code>REVIEWS.md</code> feedback from <code>/gsd-review</code>. Looped form: <code>/gsd-plan-review-convergence</code>.</li>
  <li><code>--gaps</code> / <code>--gaps-only</code> — work only on <code>gap_closure: true</code> plans. Plug verify-work failures back into <code>execute-phase --gaps-only</code>.</li>
  <li><code>--ws &lt;name&gt;</code> — scope to a non-active workstream. <code>--depth=quick|standard|deep</code> on code-review. <code>--profile quality|balanced|budget|inherit</code> on config.</li>
  <li>Phase arg accepts <code>12</code>, <code>72.1</code> (inserted urgent), <code>12a</code> (letter-suffix). Optional ⇒ auto-detect from STATE.md.</li>
  <li><strong>Flag activation rule:</strong> a flag is active <em>only</em> when its literal token appears in <code>$ARGUMENTS</code>. "Documented" ≠ "default-on".</li>
</ul>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>GSD — Printable Help</title>
<style>
  /* ---------- page setup ---------- */
  @page { size: A4 portrait; margin: 12mm 12mm 14mm 12mm; }
  @page landscape { size: A4 landscape; margin: 12mm 12mm 14mm 12mm; }

  html, body { font-family: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; }
  body { font-size: 10pt; line-height: 1.4; margin: 0; }

  /* every top-level section is its own page (unless flow-page) */
  section.page { page-break-after: always; break-after: page; padding: 0; }
  section.flow-page { padding: 0; }
  section.flow-page + section.flow-page { page-break-before: auto; }

  section.diagram-page { page-break-after: always; break-after: page; padding: 0; display: flex; flex-direction: column; height: calc(297mm - 28mm); }
  section.diagram-page.landscape { page: landscape; height: calc(210mm - 28mm); }

  .page-head { border-bottom: 1px solid #ccc; padding-bottom: 4mm; margin-bottom: 6mm; }
  .page-head .part-label { display: inline-block; font-size: 8pt; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #888; }
  .page-head h2 { margin: 1mm 0 0 0; font-size: 16pt; font-weight: 600; color: #222; }

  .diagram-frame { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .diagram-frame svg { max-width: 100%; max-height: 100%; width: auto; height: auto; }

  /* cover / mental model page */
  .cover { padding-top: 6mm; }
  .cover .title { font-size: 28pt; font-weight: 700; letter-spacing: -0.01em; margin: 0; color: #111; }
  .cover .subtitle { color: #666; margin: 2mm 0 8mm 0; font-size: 11pt; }
  .cover h3 { font-size: 14pt; margin: 6mm 0 2mm 0; color: #222; }

  /* part 2 cover separator */
  .part2-cover { padding-top: 80mm; text-align: center; }
  .part2-cover .title { font-size: 26pt; font-weight: 700; color: #111; }
  .part2-cover .subtitle { color: #666; margin-top: 4mm; font-size: 11pt; }

  /* typography */
  h2 { font-size: 14pt; margin: 6mm 0 2mm; color: #222; border-bottom: 1px solid #eee; padding-bottom: 1mm; }
  h3 { font-size: 12pt; margin: 5mm 0 2mm; color: #333; }
  h4 { font-size: 10.5pt; margin: 4mm 0 1mm; color: #444; }
  p { margin: 0 0 2mm 0; }
  strong { color: #111; }
  em { font-style: italic; }
  blockquote { margin: 2mm 0; padding: 1mm 4mm; border-left: 3px solid #bbb; color: #555; font-size: 9.5pt; }
  hr { border: none; border-top: 1px solid #ddd; margin: 4mm 0; }

  ul, ol { margin: 1mm 0 3mm 6mm; padding: 0; }
  li { margin: 0.5mm 0; }

  code { font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; font-size: 9pt; background: #f3f3f3; padding: 0 2px; border-radius: 3px; color: #2a2a2a; }
  pre.code { background: #f7f7f7; border: 1px solid #e3e3e3; border-radius: 4px; padding: 2mm 3mm; font-size: 8.5pt; line-height: 1.35; overflow: hidden; white-space: pre-wrap; word-break: break-word; margin: 2mm 0 3mm 0; }
  pre.code code { background: transparent; padding: 0; font-size: inherit; }

  /* tables: keep rows from splitting; allow tables to span pages */
  table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm 0; font-size: 8.5pt; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  th, td { border: 1px solid #e0e0e0; padding: 1.4mm 2mm; vertical-align: top; text-align: left; }
  th { background: #f0f3f7; font-weight: 600; color: #222; }
  td code { font-size: 8pt; }

  /* cheat sheet */
  ul.cheat-sheet { font-size: 9.5pt; margin-left: 5mm; }
  ul.cheat-sheet li { margin: 1.5mm 0; }

  /* accents from mermaid classDef parity for inline notes */
  .legend { font-size: 9pt; color: #555; margin: 2mm 0; }
  .legend .opt { border: 1px dashed #999; padding: 0 4px; border-radius: 3px; }
  .legend .gate { background: #ffd; border: 1px solid #aa3; padding: 0 4px; border-radius: 3px; }
  .legend .rem { background: #fdd; border: 1px solid #a33; padding: 0 4px; border-radius: 3px; }
  .legend .obs { background: #dfe; border: 1px solid #3a3; padding: 0 4px; border-radius: 3px; }
  .legend .sav { background: #dde; border: 1px solid #338; padding: 0 4px; border-radius: 3px; }
  .legend .stand { background: #dde; border: 1px solid #446; padding: 0 4px; border-radius: 3px; }

  /* footer note */
  .pagefoot { font-size: 7.5pt; color: #999; text-align: right; margin-top: 4mm; }

  /* part 1 prose page padding (used for rules/cheat sheet pages) */
  section.prose-page { padding: 0; page-break-after: always; break-after: page; }

  /* avoid orphan headings */
  h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
</style>
</head>
<body>

<!-- ============================================================== -->
<!-- PART 1 — Quick operational reference                            -->
<!-- ============================================================== -->

<section class="page cover">
  <div class="part-label" style="font-size:8pt;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#888;">Part 1 · Quick operational reference</div>
  <h1 class="title">GSD — Power-User Reference</h1>
  <p class="subtitle">Printable workflow loops, gates, and command cheat sheet. Each diagram fits one A4 page.</p>

  <h3>Mental model in 60 seconds</h3>
  ${renderMarkdown(s1)}

  <p class="legend">
    Legend:
    <span class="opt">optional</span>
    <span class="gate">gate</span>
    <span class="rem">remediation</span>
    <span class="obs">observability</span>
    <span class="sav">capture</span>
    <span class="stand">standalone</span>
  </p>
  <div class="pagefoot">Generated from HELP.md · keep alongside <code>README.md</code> · regenerate via <code>node scripts/build-help-pdf.js</code></div>
</section>

${diagramPage(0)}
${diagramPage(1)}
${diagramPage(2)}

<section class="prose-page">
  <header class="page-head">
    <span class="part-label">Part 1 · Workflows</span>
    <h2>Phase-loop rules &amp; gates</h2>
  </header>
  ${renderMarkdown(s3Rules)}
</section>

${diagramPage(3)}
${diagramPage(4)}
${diagramPage(5)}

<section class="prose-page">
  <header class="page-head">
    <span class="part-label">Part 1 · Cheat sheets</span>
    <h2>Namespace routers &amp; flag conventions</h2>
  </header>
  ${renderMarkdown(s9)}
  <h3>Most-used flag conventions</h3>
  ${cheatSheet}
</section>

<!-- ============================================================== -->
<!-- PART 2 — Detailed reference (page break)                        -->
<!-- ============================================================== -->

<section class="page part2-cover">
  <div class="part-label" style="font-size:9pt;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#888;">Part 2</div>
  <h1 class="title">Detailed reference</h1>
  <p class="subtitle">Every command, every flag. Sourced verbatim from HELP.md §7, §8, §10.</p>
</section>

<section class="prose-page">
  <header class="page-head">
    <span class="part-label">Part 2 · Reference</span>
    <h2>Standalone commands</h2>
  </header>
  ${renderMarkdown(s7)}
</section>

<section class="prose-page">
  <header class="page-head">
    <span class="part-label">Part 2 · Reference</span>
    <h2>Full command reference</h2>
  </header>
  ${renderMarkdown(s8)}
</section>

<section class="prose-page">
  <header class="page-head">
    <span class="part-label">Part 2 · Reference</span>
    <h2>Argument &amp; flag conventions</h2>
  </header>
  ${renderMarkdown(s10)}
  <div class="pagefoot">End of HELP.pdf · regenerate with <code>node scripts/build-help-pdf.js</code></div>
</section>

</body>
</html>`;
  return html;
}

// -------- step 6: chromium → PDF -----------------------------------------

function findChromium() {
  // 1. Homebrew chromium binary
  const w = which('chromium');
  if (w) return w;
  // 2. macOS apps
  const mac = [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of mac) if (fs.existsSync(p)) return p;
  return null;
}

function printPdf(htmlPath, outPath) {
  const bin = findChromium();
  if (!bin) throw new Error('No chromium / Chrome found. Install via `brew install chromium`.');
  log(`printing PDF via ${bin}`);
  const url = 'file://' + htmlPath;
  execFileSync(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--virtual-time-budget=10000',
    `--print-to-pdf=${outPath}`,
    url,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
}

// -------- main -------------------------------------------------------------

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`HELP.md not found at ${SRC}`);
  const md = fs.readFileSync(SRC, 'utf8');
  const blocks = extractMermaidBlocks(md);
  log(`found ${blocks.length} mermaid blocks`);
  if (blocks.length !== 5) {
    log(`WARNING: expected 5 mermaid blocks, found ${blocks.length}. Diagram pages may be off.`);
  }
  const sections = sliceSections(md);
  const pages = renderMermaid(blocks);
  const html = buildHtml({ sections, pages });
  ensureDir(BUILD_DIR);
  fs.writeFileSync(HTML_PATH, html);
  log(`wrote ${HTML_PATH}`);
  printPdf(HTML_PATH, OUT_PDF);
  const stat = fs.statSync(OUT_PDF);
  log(`wrote ${OUT_PDF} (${(stat.size / 1024).toFixed(1)} KB)`);
}

try { main(); } catch (e) {
  log(`ERROR: ${e.message}`);
  process.exit(1);
}
