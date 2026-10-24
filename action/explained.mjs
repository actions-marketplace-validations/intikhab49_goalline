// The goalline Action's note on what a goalpost run found explained: a warning annotation on each test
// file whose flagged tests the change explains in .goalpost-acks.json (they don't fail the step, so
// the warning shows the reviewer where the files are), and how many such files there are, as the
// step's `explained` output.   node action/explained.mjs <receipt.dsse.json>
import fs from 'node:fs';

let files = [];
try {
  const envelope = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  files = statement.predicate.configuration[0].annotations.details.files || [];
} catch {
  // No receipt to read: nothing explained.
}

// Workflow commands: the message escapes %, CR and LF; a property also escapes : and ,.
const message = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const property = (s) => message(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const explained = files.filter((f) => f.allExplained);
for (const f of explained.slice(0, 10)) {
  const values = new Map((f.failing || []).map((name, i) => [name, f.failingWhy?.[i] || '']));
  const parts = f.explained.map((x) =>
    x.test === '*' ? `${f.note}. Why: ${x.why}` : `✗ ${x.test}${values.get(x.test) ? `: ${values.get(x.test)}` : ''}. Why: ${x.why}`,
  );
  const text = `An old test no longer passes on the new code, and the change says why. Check that the reason matches the change. ${parts.join(' · ')}`;
  console.log(`::warning file=${property(f.now || f.path)},title=${property('goalline: changed on purpose?')}::${message(text.slice(0, 1500))}`);
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `explained=${explained.length}\n`);
