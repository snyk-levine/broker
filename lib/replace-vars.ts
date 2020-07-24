/**
 * This function replaces values wrapped with `${` `}` with its respective
 * value from the supplied k/v map
 *
 * @example
 * const str = replaceVars('Hello ${PLACE}!', { PLACE: 'World' });
 *
 * console.log(str); // Hello World!
 */
export function replaceVars(
  input: string,
  replaceMap: { [key: string]: string },
) {
  if (input === '') {
    return '';
  }

  return input.replace(/(\${.*?})/g, (_, match) => {
    const key = match.slice(2, -1); // Remove the wrapping `${` and `}` chars
    return replaceMap[key] ?? '';
  });
}
