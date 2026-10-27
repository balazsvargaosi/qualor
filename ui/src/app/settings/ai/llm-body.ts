import type { RequestBody } from '../../api/types';

/** The replace-all body of `PUT /system/llm`, which every section of the instance page saves. */
export type LlmBody = RequestBody<'/api/v0/system/llm', 'put'>;
