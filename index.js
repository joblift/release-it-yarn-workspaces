const fs = require('fs');
const path = require('path');
const semver = require('semver');
const urlJoin = require('url-join');
const walkSync = require('walk-sync');
const detectNewline = require('detect-newline');
const detectIndent = require('detect-indent');
const { rejectAfter } = require('release-it/lib/util');
const { npmTimeoutError, npmAuthError } = require('release-it/lib/errors');
const { Plugin } = require('release-it');

const options = { write: false };

const ROOT_MANIFEST_PATH = './package.json';
const REGISTRY_TIMEOUT = 10000;
const DEFAULT_TAG = 'latest';
const NPM_BASE_URL = 'https://www.npmjs.com';
const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DETECT_TRAILING_WHITESPACE = /\s+$/;

function resolveWorkspaces(workspaces) {
  if (Array.isArray(workspaces)) {
    return workspaces;
  } else if (workspaces !== null && typeof workspaces === 'object') {
    return workspaces.packages;
  }

  throw new Error(
    "This package doesn't use yarn workspaces. (package.json doesn't contain a `workspaces` property)"
  );
}

function parseVersion(raw) {
  if (!raw) return { version: null, isPreRelease: false, preReleaseId: null };

  const version = semver.valid(raw) ? raw : semver.coerce(raw);
  const parsed = semver.parse(version);

  const isPreRelease = parsed.prerelease.length > 0;
  const preReleaseId = isPreRelease && isNaN(parsed.prerelease[0]) ? parsed.prerelease[0] : null;

  return {
    version,
    isPreRelease,
    preReleaseId,
  };
}

function buildReplacementDepencencyVersion(existingVersion, newVersion) {
  let isExistingVersionExact = semver.parse(existingVersion);

  if (isExistingVersionExact) {
    return newVersion;
  }

  // coerce strips any leading `^` or `~`
  let existingVersionCoerced = semver.coerce(existingVersion);
  if (existingVersionCoerced) {
    return existingVersion.replace(existingVersionCoerced.toString(), newVersion);
  }

  return newVersion;
}

class JSONFile {
  constructor(filename) {
    let contents = fs.readFileSync(filename, { encoding: 'utf8' });

    this.filename = filename;
    this.pkg = JSON.parse(contents);
    this.lineEndings = detectNewline(contents);
    this.indent = detectIndent(contents).amount;

    let trailingWhitespace = DETECT_TRAILING_WHITESPACE.exec(contents);
    this.trailingWhitespace = trailingWhitespace ? trailingWhitespace : '';
  }

  write() {
    let contents = JSON.stringify(this.pkg, null, this.indent).replace(/\n/g, this.lineEndings);

    fs.writeFileSync(this.filename, contents + this.trailingWhitespace, { encoding: 'utf8' });
  }
}

module.exports = class YarnWorkspacesPlugin extends Plugin {
  static isEnabled(options) {
    return fs.existsSync(ROOT_MANIFEST_PATH) && options !== false;
  }

  constructor(...args) {
    super(...args);

    this.registerPrompts({
      publish: {
        type: 'confirm',
        message: (context) => {
          const { distTag, packageNames } = context['release-it-yarn-workspaces'];

          return this._formatPublishMessage(distTag, packageNames);
        },
        default: true,
      },
      otp: {
        type: 'input',
        message: () => `Please enter OTP for npm:`,
      },
      'publish-as-public': {
        type: 'confirm',
        message(context) {
          const { packageName } = context;

          return `Publishing ${packageName} failed because \`publishConfig.access\` is not set in its \`package.json\`.\n  Would you like to publish ${packageName} as a public package?`;
        },
      },
    });

    const { publishConfig, workspaces } = require(path.resolve(ROOT_MANIFEST_PATH));

    this.setContext({
      publishConfig,
      workspaces: this.options.workspaces || resolveWorkspaces(workspaces),
      root: process.cwd(),
    });
  }

  async init() {
    if (this.options.skipChecks) return;

    const validations = Promise.all([this.isRegistryUp(), this.isAuthenticated()]);

    await Promise.race([validations, rejectAfter(REGISTRY_TIMEOUT)]);

    const [isRegistryUp, isAuthenticated] = await validations;

    if (!isRegistryUp) {
      throw new npmTimeoutError(REGISTRY_TIMEOUT);
    }

    if (!isAuthenticated) {
      throw new npmAuthError();
    }
  }

  beforeBump() {
    // TODO: implement printing of workspaces found
  }

  async bump(version) {
    let { distTag } = this.options;

    if (!distTag) {
      const { isPreRelease, preReleaseId } = parseVersion(version);
      distTag = this.options.distTag || isPreRelease ? preReleaseId : DEFAULT_TAG;
    }
    const workspaces = this.getWorkspaces();
    const packageNames = workspaces.map((workspace) => workspace.name);

    this.setContext({
      distTag,
      version,
      packageNames,
    });

    const task = async () => {
      if (this.global.isDryRun) {
        this.log.exec(`Bumping versions in ${packageNames.join(', ')}`);
        return;
      }

      workspaces.forEach(({ pkgInfo }) => {
        let { pkg } = pkgInfo;
        let originalVersion = pkg.version;

        if (originalVersion === version) {
          this.log.warn(`Did not update version in package.json, etc. (already at ${version}).`);
        }

        pkg.version = version;

        this._updateDependencies(pkg.dependencies, version);
        this._updateDependencies(pkg.devDependencies, version);
        this._updateDependencies(pkg.optionalDependencies, version);
        this._updateDependencies(pkg.peerDependencies, version);

        pkgInfo.write();
      });
    };

    return this.spinner.show({ task, label: 'npm version' });
  }

  async release() {
    if (this.options.publish === false) return;

    // creating a stable object that is shared across all package publishes
    // this ensures that we don't accidentally prompt multiple times (e.g. once
    // per package) due to loosing the otp value after each `this.publish` call
    const otp = {
      value: this.options.otp,
    };

    const tag = this.getContext('distTag');
    const task = async () => {
      await this.eachWorkspace(async (workspaceInfo) => {
        await this.publish({ tag, workspaceInfo, otp });
      });
    };

    await this.step({ task, label: 'npm publish', prompt: 'publish' });
  }

  async afterRelease() {
    let workspaces = this.getWorkspaces();

    workspaces.forEach((workspaceInfo) => {
      if (workspaceInfo.isReleased) {
        this.log.log(`🔗 ${this.getReleaseUrl(workspaceInfo)}`);
      }
    });
  }

  _updateDependencies(dependencies, newVersion) {
    const workspaces = this.getWorkspaces();

    if (dependencies) {
      for (let dependency in dependencies) {
        if (workspaces.find((w) => w.name === dependency)) {
          const existingVersion = dependencies[dependency];

          dependencies[dependency] = buildReplacementDepencencyVersion(existingVersion, newVersion);
        }
      }
    }
  }

  _formatPublishMessage(distTag, packageNames) {
    const messages = [
      'Preparing to publish:',
      ...packageNames.map((name) => `    ${name}${distTag === 'latest' ? '' : `@${distTag}`}`),
      '  Publish to npm:',
    ];

    return messages.join('\n');
  }

  async isRegistryUp() {
    const registry = this.getRegistry();

    try {
      await this.exec(`npm ping --registry ${registry}`);

      return true;
    } catch (error) {
      if (/code E40[04]|404.*(ping not found|No content for path)/.test(error)) {
        this.log.warn('Ignoring unsupported `npm ping` command response.');
        return true;
      }
      return false;
    }
  }

  async isAuthenticated() {
    const registry = this.getRegistry();

    try {
      await this.exec(`npm whoami --registry ${registry}`);
      return true;
    } catch (error) {
      this.debug(error);

      if (/code E40[04]/.test(error)) {
        this.log.warn('Ignoring unsupported `npm whoami` command response.');
        return true;
      }

      return false;
    }
  }

  getReleaseUrl(workspaceInfo) {
    const registry = this.getRegistry();
    const baseUrl = registry !== NPM_DEFAULT_REGISTRY ? registry : NPM_BASE_URL;

    return urlJoin(baseUrl, 'package', workspaceInfo.name);
  }

  getRegistry() {
    return this.getContext('publishConfig.registry') || NPM_DEFAULT_REGISTRY;
  }

  async publish({ tag, workspaceInfo, otp, access } = {}) {
    const isScoped = workspaceInfo.name.startsWith('@');
    const otpArg = otp.value ? ` --otp ${otp.value}` : '';
    const accessArg = access ? ` --access ${access}` : '';
    const dryRunArg = this.global.isDryRun ? ' --dry-run' : '';

    if (workspaceInfo.isPrivate) {
      this.log.warn(`${workspaceInfo.name}: Skip publish (package is private)`);
      return;
    }

    try {
      await this.exec(`npm publish . --tag ${tag}${accessArg}${otpArg}${dryRunArg}`, {
        options,
      });

      workspaceInfo.isReleased = true;
    } catch (err) {
      this.debug(err);
      if (/one-time pass/.test(err)) {
        if (otp.value != null) {
          this.log.warn('The provided OTP is incorrect or has expired.');
        }

        await this.step({
          prompt: 'otp',
          task(newOtp) {
            otp.value = newOtp;
          },
        });

        return await this.publish({ tag, workspaceInfo, otp, access });
      } else if (isScoped && /private packages/.test(err)) {
        let publishAsPublic = false;
        await this.step({
          prompt: 'publish-as-public',
          packageName: workspaceInfo.name,
          task(value) {
            publishAsPublic = value;
          },
        });

        if (publishAsPublic) {
          return await this.publish({ tag, workspaceInfo, otp, access: 'public' });
        } else {
          this.log.warn(`${workspaceInfo.name} was not published.`);
        }
      }
      throw err;
    }
  }

  async eachWorkspace(action) {
    let workspaces = this.getWorkspaces();

    for (let workspaceInfo of workspaces) {
      try {
        process.chdir(workspaceInfo.root);
        await action(workspaceInfo);
      } finally {
        process.chdir(this.getContext('root'));
      }
    }
  }

  getWorkspaces() {
    if (this._workspaces) {
      return this._workspaces;
    }

    let root = this.getContext('root');
    let workspaces = this.getContext('workspaces');

    let packageJSONFiles = walkSync('.', {
      globs: workspaces.map((glob) => `${glob}/package.json`),
    });

    this._workspaces = packageJSONFiles.map((file) => {
      let absolutePath = path.join(root, file);
      let pkgInfo = new JSONFile(absolutePath);

      let relativeRoot = path.dirname(file);

      return {
        root: path.join(root, relativeRoot),
        relativeRoot,
        name: pkgInfo.pkg.name,
        isPrivate: !!pkgInfo.pkg.private,
        isReleased: false,
        pkgInfo,
      };
    });

    return this._workspaces;
  }
};
