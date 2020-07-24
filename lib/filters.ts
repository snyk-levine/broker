import * as minimatch from 'minimatch';
import * as path from 'path';
import * as pathRegexp from 'path-to-regexp';
import * as qs from 'qs';
import * as undefsafe from 'undefsafe';
import * as config from './config';
import * as logger from './log';
import { replaceVars } from './replace-vars';
import * as tryJSONParse from './try-json-parse';

type BodyFilter = { path: string; value: string[] };
type BodyRegexFilter = { path: string; regex: string; value: string[] };
type QueryFilter = { queryParam: string; values: string[] };
type HeaderFilter = { header: string; values: string[] };

type BasicAuth = { scheme: 'basic'; username: string; password: string };
type TokenAuth = { scheme: 'token'; token: string };

interface Rule {
  method: string;
  path: string;
  origin: string;
  valid?: (BodyFilter | BodyRegexFilter | QueryFilter | HeaderFilter)[];
  stream?: boolean;
  auth: BasicAuth | TokenAuth;
}

function getAuthHeader(auth: BasicAuth | TokenAuth): string | void {
  if (auth.scheme === 'token') {
    return `Token ${replaceVars(auth.token, config)}`;
  }

  if (auth.scheme === 'basic') {
    const basicAuth = [
      replaceVars(auth.username, config),
      replaceVars(auth.password, config),
    ].join(':');

    return `Basic ${Buffer.from(basicAuth).toString('base64')}`;
  }
}

const validateHeaders = (
  headerFilters: HeaderFilter[],
  requestHeaders = [],
) => {
  for (const filter of headerFilters) {
    const headerValue = requestHeaders[filter.header];

    if (!headerValue) {
      return false;
    }

    if (!filter.values.includes(headerValue)) {
      return false;
    }
  }

  return true;
};

export function createFilters(ruleSource: Rule[]) {
  let rules: Rule[] = [];

  if (Array.isArray(ruleSource)) {
    rules = ruleSource;
  } else if (ruleSource) {
    try {
      rules = require(ruleSource);
    } catch (error) {
      logger.warn(
        { ruleSource, error },
        'Unable to parse rule source, ignoring',
      );
    }
  }

  if (!Array.isArray(rules)) {
    throw new Error(
      `Expected array of filter rules, got '${typeof rules}' instead.`,
    );
  }

  logger.info({ rulesCount: rules.length }, 'loading new rules');

  // array of entries with
  const tests = rules.map((rule) => {
    const method = rule.method.toLowerCase() ?? 'get';
    const valid = rule.valid ?? [];

    const bodyRegexFilters: BodyRegexFilter[] = [];
    const bodyFilters: BodyFilter[] = [];
    const queryFilters: QueryFilter[] = [];
    const headerFilters: HeaderFilter[] = [];

    valid.forEach((v) => {
      if ('path' in v && 'regex' in v) {
        bodyRegexFilters.push(v);
      }

      if ('path' in v && !('regex' in v)) {
        bodyFilters.push(v);
      }

      if ('queryParam' in v) {
        queryFilters.push(v);
      }

      if ('header' in v) {
        headerFilters.push(v);
      }
    });

    // now track if there's any values that we need to interpolate later
    const fromConfig = {};

    // slightly bespoke version of replace-vars.ts
    let entryPath =
      'path' in rule
        ? rule.path.replace(/(\${.*?})/g, (_, match) => {
            const key = match.slice(2, -1); // Remove the wrapping `${` and `}` chars
            fromConfig[key] = config[key] ?? '';
            return ':' + key;
          })
        : '/';

    if (entryPath[0] !== '/') {
      entryPath = '/' + entryPath;
    }

    const origin = replaceVars(rule.origin, config);

    logger.info({ method, path: entryPath }, 'adding new filter rule');

    const keys: pathRegexp.Key[] = [];
    const regexp = pathRegexp(entryPath, keys);

    return (req: {
      method: string;
      url: string;
      headers: any;
      body: unknown;
    }) => {
      // check the request method
      if (req.method.toLowerCase() !== method && method !== 'any') {
        return false;
      }

      // Do not allow directory traversal
      if (path.normalize(req.url) !== req.url) {
        return false;
      }

      // Discard any fragments before further processing
      const mainURI = req.url.split('#')[0];

      // query params might contain additional "?"s, only split on the 1st one
      const parts = mainURI.split('?');
      let [url, querystring] = [parts[0], parts.slice(1).join('?')];
      const res = regexp.exec(url);
      if (!res) {
        // no url match
        return false;
      }

      // reconstruct the url from the user config
      for (let i = 1; i < res.length; i++) {
        const val = fromConfig[keys[i - 1].name];
        if (val) {
          url = url.replace(res[i], val);
        }
      }

      // if validity filters are present, at least one must be satisfied
      if (
        bodyFilters.length ||
        bodyRegexFilters.length ||
        queryFilters.length
      ) {
        let isValid;

        let parsedBody;
        if (bodyFilters.length) {
          parsedBody = tryJSONParse(req.body);

          // validate against the body
          isValid = bodyFilters.some(({ path: filterPath, value }) => {
            return undefsafe(parsedBody, filterPath, value);
          });
        }

        if (!isValid && bodyRegexFilters.length) {
          parsedBody = parsedBody || tryJSONParse(req.body);

          // validate against the body by regex
          isValid = bodyRegexFilters.some(({ path: filterPath, regex }) => {
            try {
              const re = new RegExp(regex);
              return re.test(undefsafe(parsedBody, filterPath));
            } catch (error) {
              logger.error(
                { error, path: filterPath, regex },
                'failed to test regex rule',
              );
              return false;
            }
          });
        }

        // no need to check query filters if the request is already valid
        if (!isValid && queryFilters.length) {
          const parsedQuerystring = qs.parse(querystring);

          // validate against the querystring
          isValid = queryFilters.some(({ queryParam, values }) => {
            return values.some((value) =>
              minimatch(parsedQuerystring[queryParam] || '', value),
            );
          });
        }

        if (!isValid) {
          return false;
        }
      }

      if (headerFilters.length) {
        if (!validateHeaders(headerFilters, req.headers)) {
          return false;
        }
      }

      logger.debug(
        { path: entryPath, origin, url, querystring },
        'rule matched',
      );

      querystring = querystring ? `?${querystring}` : '';

      return {
        url: origin + url + querystring,
        auth: rule.auth && getAuthHeader(rule.auth),
        stream: rule.stream,
      };
    };
  });

  return (payload, callback) => {
    logger.debug({ rulesCount: tests.length }, 'looking for a rule match');

    if (tests.some((test) => test(payload))) {
      return callback(null, true);
    }

    return callback(Error('blocked'));
  };
}
