import { detect } from '../dist/adapters/index.js';

const samples = {
  'claude-code': 'C:/Users/winno/projects/cairn/cairn/docs/study_sessions/fable_first_817c311b-ce8b-460d-9f0d-eafbbe18ad02.jsonl',
  'pi':          'C:/Users/winno/.pi/agent/sessions/--C--Users-winno-projects-cwar-cwar-engine--/2026-06-08T16-35-50-273Z_019ea817-2781-74b8-967f-211d4e8cb5ca.jsonl',
  'antigravity': 'C:/Users/winno/.gemini/antigravity/conversations/01ccc93c-3fba-411d-87f5-2e780175398f.db',
};

let ok = true;
for (const [expected, p] of Object.entries(samples)) {
  let got;
  try { got = detect(p); } catch (e) { got = 'THREW:' + e.message; }
  const pass = got === expected;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  expected=${expected}  detected=${got}`);
}
console.log(ok ? 'ALL ROUTING CORRECT' : 'ROUTING MISMATCH');
