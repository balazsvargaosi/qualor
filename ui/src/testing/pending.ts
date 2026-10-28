/**
 * What a test's resolver holds until the request it waits for has been made: a function that takes
 * any argument and does nothing. The test then replaces it with the real `resolve`.
 */
export const noAnswerYet: (...args: unknown[]) => void = () => undefined;
