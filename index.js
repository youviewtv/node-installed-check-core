import { listInstalled } from 'list-installed';
import { ErrorWithCause } from 'pony-cause';
import { readPackage } from 'read-pkg';

import { checkPackageVersions } from './lib/check-package-versions.js';
import { checkEngineVersions } from './lib/check-engine-versions.js';

/**
 * @typedef InstalledCheckResult
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {string[]} notices
 */

/**
 * @typedef InstalledCheckOptions
 * @property {string|undefined} [path]
 * @property {boolean|undefined} engineCheck
 * @property {string[]|undefined} [engineIgnores]
 * @property {boolean|undefined} [engineNoDev]
 * @property {boolean|undefined} versionCheck
 */

/**
 * @throws {Error}
 * @param {InstalledCheckOptions} options
 * @returns {Promise<InstalledCheckResult>}
 */
export async function installedCheck (options) {
  if (!options) throw new Error('Expected options to be set');

  const {
    engineCheck = false,
    engineIgnores = [],
    engineNoDev = false,
    path = '.',
    versionCheck = false,
    traverseWorkspaces = true,
  } = options;

  if (!engineCheck && !versionCheck) {
    throw new Error('Expected to run at least one check. Add engineCheck and/or versionCheck');
  }

  const checks = [];

  const [
    mainPackage,
    mainInstalledDependencies,
  ] = await Promise.all([
    readPackage({ cwd: path }).catch(/** @param {Error} err */ err => {
      throw new ErrorWithCause('Failed to read package.json', { cause: err });
    }),
    listInstalled(path).catch(/** @param {Error} err */ err => {
      throw new ErrorWithCause('Failed to list installed modules', { cause: err });
    }),
  ]);

  const mainRequiredDependencies = Object.assign({}, mainPackage.dependencies || {}, mainPackage.devDependencies || {});
  const mainOptionalDependencies = Object.assign({}, mainPackage.optionalDependencies || {});

  checks.push({
    engines: mainPackage.engines || {},
    dependencies: mainPackage.dependencies || {},
    requiredDependencies: mainRequiredDependencies,
    optionalDependencies: mainOptionalDependencies,
    installedDependencies: mainInstalledDependencies
  });

  if (traverseWorkspaces && mainPackage.workspaces) {
    await Promise.all(
      // TODO dedupe root dir more accurately
      mainPackage.workspaces.filter(w => w !== '.').map(w => {
        // TODO create subpath more accurately
        const subpath = path + '/' + w;
        return Promise.all([
          readPackage({ cwd: subpath }).catch(/** @param {Error} err */ err => {
            throw new ErrorWithCause('Failed to read workspace package.json', { cause: err });
          }),
          listInstalled(subpath).catch(() => (new Map()))
        ]).then(([subPackage, subInstalled]) => {
          const installedDependencies = new Map(mainInstalledDependencies);
          subInstalled.forEach((value, key) => installedDependencies.set(key, value));
          checks.push({
            subpath,
            engines: subPackage.engines || mainPackage.engines || {},
            dependencies: subPackage.dependencies || mainPackage.dependencies || {},
            requiredDependencies: Object.assign({}, subPackage.dependencies || {}, subPackage.devDependencies || {}),
            optionalDependencies: Object.assign({}, subPackage.optionalDependencies || {}),
            installedDependencies,
          });
        });
      })
    );
  }

  /** @type {string[]} */
  let errors = [];
  /** @type {string[]} */
  let warnings = [];

  if (versionCheck) {
    checks.forEach((check) => {
      const packageResult = checkPackageVersions(check.requiredDependencies, check.installedDependencies, check.optionalDependencies);
      errors = [...errors, ...packageResult.errors.map(str => check.subpath ? '[' + check.subpath + '] ' + str : str)];
      warnings = [...warnings, ...packageResult.warnings.map(str => check.subpath ? '[' + check.subpath + '] ' + str : str)];
    });
  }

  if (engineCheck) {
    checks.forEach((check) => {
      const dependencies = Object.assign({}, engineNoDev ? check.dependencies : check.requiredDependencies);

      for (const name of (engineIgnores || [])) {
        delete dependencies[name];
      }

      const engineResult = checkEngineVersions(
        check.engines,
        dependencies,
        check.installedDependencies,
        check.optionalDependencies
      );

      errors = [...errors, ...engineResult.errors.map(str => check.subpath ? '[' + check.subpath + '] ' + str : str)];
      warnings = [...warnings, ...engineResult.warnings.map(str => check.subpath ? '[' + check.subpath + '] ' + str : str)];
    });
  }

  return { errors, warnings, notices: [] };
}
