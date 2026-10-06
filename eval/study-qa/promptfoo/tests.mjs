// promptfoo tests generated from the labelled B03 questions. Each assertion is
// a named metric so the summary reads as recall@5, isolation, version,
// citation-support and not-found rates.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { questions } = JSON.parse(readFileSync(join(here, '../fixtures/questions.json'), 'utf8'));
const answers = process.env.EVAL_ANSWERS === '1';

const js = (metric, value) => ({ type: 'javascript', metric, value });

export default function generateTests() {
  return questions.map((question) => {
    const answerable = question.answerable !== false;
    const assert = [
      js(
        'isolation',
        'const r = JSON.parse(output); return r.foreignHits === 0 && r.outOfScopeHits === 0;',
      ),
      js('version', 'return JSON.parse(output).oldVersionHits === 0;'),
    ];
    if (answerable) assert.push(js('recall@5', 'return JSON.parse(output).hybridHit === true;'));
    if (answers && answerable) {
      assert.push(
        js(
          'citation-support',
          'const a = JSON.parse(output).answer; return !!a && a.groundedClaims > 0 && a.supportedClaims === a.groundedClaims;',
        ),
      );
    }
    if (answers && !answerable) {
      assert.push(
        js(
          'not-found',
          'const a = JSON.parse(output).answer; return !!a && a.notFoundCorrect === true;',
        ),
      );
    }
    return {
      description: `${question.id} ${question.category}`,
      vars: { id: question.id, question: question.question },
      assert,
    };
  });
}
