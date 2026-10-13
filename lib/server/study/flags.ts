/**
 * Runtime switches for the study material library (learning plan B02). Kept
 * free of request-handling imports so the generation worker can read them.
 */

/** ZHIYU_STUDY_MATERIALS_ENABLED: the library pages/APIs and the worker's learning-task runner. */
export function isStudyMaterialsFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_MATERIALS_ENABLED;
  return flag === '1' || flag === 'true';
}

/** ZHIYU_STUDY_TASKS_ACCEPTING=0 stops new parse tasks; queued and running ones still finish. */
export function isStudyTaskIntakeOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZHIYU_STUDY_TASKS_ACCEPTING !== '0';
}

/** ZHIYU_STUDY_QA_ENABLED: retrieval indexing and cited answers (learning plan B03); needs materials. */
export function isStudyQaFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_QA_ENABLED;
  return (flag === '1' || flag === 'true') && isStudyMaterialsFlagOn(env);
}

/** ZHIYU_STUDY_CLASSMATES_ENABLED: classmate templates and their classroom use (learning plan B04). */
export function isStudyClassmatesFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_CLASSMATES_ENABLED;
  return flag === '1' || flag === 'true';
}

/**
 * ZHIYU_STUDY_COMPANION_CHAT_ENABLED: after-class chats with one classmate
 * (learning plan B05); needs classmates. Read by web and the worker's runner.
 */
export function isStudyCompanionChatFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_COMPANION_CHAT_ENABLED;
  return (flag === '1' || flag === 'true') && isStudyClassmatesFlagOn(env);
}

/**
 * ZHIYU_STUDY_MEMORY_ENABLED: learning records, editable preferences and the
 * Memory page (learning plan B06). Read by web and the worker's runner, which
 * adds the student's preferences to after-class chats.
 */
export function isStudyMemoryFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_MEMORY_ENABLED;
  return flag === '1' || flag === 'true';
}

/**
 * ZHIYU_STUDY_EXAMS_ENABLED: question bank, rule-built papers and objective
 * attempts (learning plan B07). Web only; no model is involved.
 */
export function isStudyExamsFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_EXAMS_ENABLED;
  return flag === '1' || flag === 'true';
}

/**
 * ZHIYU_STUDY_EXTRACTION_ENABLED: extracting exercises from parsed materials
 * into the question bank (learning plan B08); needs the material library and
 * the question bank. Web only (the rule extractor and the optional model help
 * run in the request).
 */
export function isStudyExtractionFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_EXTRACTION_ENABLED;
  return (
    (flag === '1' || flag === 'true') && isStudyMaterialsFlagOn(env) && isStudyExamsFlagOn(env)
  );
}

/**
 * ZHIYU_STUDY_GRADING_ENABLED: open questions in new papers and their
 * assisted grading (learning plan B09); needs the question bank. Web only
 * (grading runs in the request). Off: no new open items in papers and no new
 * gradings; answers, finished gradings and waiting items stay readable.
 */
export function isStudyGradingFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ZHIYU_STUDY_GRADING_ENABLED;
  return (flag === '1' || flag === 'true') && isStudyExamsFlagOn(env);
}
