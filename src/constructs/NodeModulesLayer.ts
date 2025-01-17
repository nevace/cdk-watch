import execa from 'execa';
import * as fs from 'fs-extra';
import * as path from 'path';
import objectHash from 'object-hash';
import findUp from 'find-up';
import {LockFile, extractDependencies} from 'aws-cdk-lib/aws-lambda-nodejs';
import {Code, LayerVersion} from 'aws-cdk-lib/aws-lambda';
import {Construct} from 'constructs';
import {RemovalPolicy} from 'aws-cdk-lib';
import {CDK_WATCH_OUTDIR} from '../consts';

interface NodeModulesLayerProps {
  depsLockFilePath?: string;
  pkgPath: string;
  nodeModules: string[];
  skip?: boolean;
}

enum Installer {
  NPM = 'npm',
  YARN = 'yarn',
}

/**
 * Copied from cdk source:
 * https://github.com/aws/aws-cdk/blob/ca42461acd4f42a8bd7c0fb05788c7ea50834de2/packages/@aws-cdk/aws-lambda-nodejs/lib/function.ts#L88-L103
 */
export const getDepsLock = (propsDepsLockFilePath?: string) => {
  let depsLockFilePath: string;
  if (propsDepsLockFilePath) {
    if (!fs.existsSync(propsDepsLockFilePath)) {
      throw new Error(`Lock file at ${propsDepsLockFilePath} doesn't exist`);
    }
    if (!fs.statSync(propsDepsLockFilePath).isFile()) {
      throw new Error('`depsLockFilePath` should point to a file');
    }
    depsLockFilePath = path.resolve(propsDepsLockFilePath);
  } else {
    const lockFile = findUp.sync(LockFile.YARN) ?? findUp.sync(LockFile.NPM);
    if (!lockFile) {
      throw new Error(
        'Cannot find a package lock file (`yarn.lock` or `package-lock.json`). Please specify it with `depsFileLockPath`.',
      );
    }
    depsLockFilePath = lockFile;
  }

  return depsLockFilePath;
};

export class NodeModulesLayer extends LayerVersion {
  public readonly layerVersion: string;

  constructor(scope: Construct, id: string, props: NodeModulesLayerProps) {
    const depsLockFilePath = getDepsLock(props.depsLockFilePath);

    const {pkgPath} = props;

    // Determine dependencies versions, lock file and installer
    const dependenciesPackageJson = {
      dependencies: extractDependencies(pkgPath, props.nodeModules),
    };
    let installer = Installer.NPM;
    let lockFile = LockFile.NPM;
    if (depsLockFilePath.endsWith(LockFile.YARN)) {
      lockFile = LockFile.YARN;
      installer = Installer.YARN;
    }

    const layerBase = path.join(
      process.cwd(),
      'cdk.out',
      CDK_WATCH_OUTDIR,
      'node-module-layers',
      scope.node.addr,
    );
    const outputDir = path.join(layerBase, 'nodejs');

    fs.ensureDirSync(outputDir);
    fs.copyFileSync(depsLockFilePath, path.join(outputDir, lockFile));
    fs.writeJsonSync(
      path.join(outputDir, 'package.json'),
      dependenciesPackageJson,
    );
    const layerVersion = objectHash(dependenciesPackageJson);

    if (!props.skip) {
      // eslint-disable-next-line no-console
      console.log('Installing node_modules in layer');
      execa.sync(installer, ['install'], {
        cwd: outputDir,
        stderr: 'inherit',
        stdout: 'ignore',
        stdin: 'ignore',
      });
    }

    super(scope, id, {
      removalPolicy: RemovalPolicy.DESTROY,
      description: 'NodeJS Modules Packaged into a Layer by cdk-watch',
      code: Code.fromAsset(layerBase),
      layerVersionName: layerVersion,
    });

    this.layerVersion = layerVersion;
  }
}
