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
