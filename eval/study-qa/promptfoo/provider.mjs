// promptfoo provider for the B03 evaluation: runs eval/study-qa/runner.ts once
// (bundled by ../run.mjs) and answers each test with that question's measured
// result as JSON. No model is called here beyond what the runner is configured
// to call (fake embeddings / fake answers by default).
import { pathToFileURL } from 'node:url';

import { bundleStudyQaEval } from '../run.mjs';

let reportPromise;

function report() {
  reportPromise ??= (async () => {
    const databaseUrl = process.env.EVAL_STUDY_DATABASE_URL;
    if (!databaseUrl) throw new Error('Set EVAL_STUDY_DATABASE_URL');
    const runner = await import(pathToFileURL(await bundleStudyQaEval()).href);
    return runner.runStudyQaEval({ databaseUrl, answers: process.env.EVAL_ANSWERS === '1' });
  })();
  return reportPromise;
}

export default class StudyQaProvider {
  id() {
    return 'zhiyu-study-qa';
  }

  async callApi(_prompt, context) {
    const result = (await report()).questions.find((q) => q.id === context.vars.id);
    if (!result) return { error: `no result for ${context.vars.id}` };
    return { output: JSON.stringify(result) };
  }
}
