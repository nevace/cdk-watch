import * as path from 'path';
import * as esbuild from 'esbuild';
import chalk from 'chalk';
import {execSync} from 'child_process';
import chokidar from 'chokidar';
import dependencyTree from 'dependency-tree';
import {copyCdkAssetToWatchOutdir} from '../lib/copyCdkAssetToWatchOutdir';
import {filterManifestByPath} from '../lib/filterManifestByPath';
import {initAwsSdk} from '../lib/initAwsSdk';
import {readManifest} from '../lib/readManifest';
import {resolveLambdaNamesFromManifest} from '../lib/resolveLambdaNamesFromManifest';
import {runSynth} from '../lib/runSynth';
import {updateLambdaFunctionCode} from '../lib/updateLambdaFunctionCode';
import {createCLILoggerForLambda} from '../lib/createCLILoggerForLambda';
import {twisters} from '../lib/twisters';
import {tailLogsForLambdas} from '../lib/tailLogsForLambdas';

/*
 Adapted from: https://github.com/aws/aws-cdk/blob/790a709d758333f4622c5fb860d9bbb48dee7106/packages/%40aws-cdk/aws-lambda-nodejs/lib/util.ts#L149
 */
function extractTsConfig(
  tsconfigPath: string,
  previousCompilerOptions?: Record<string, any>,
): Record<string, any> | undefined {
  // eslint-disable-next-line @typescript-eslint/no-require-imports,global-require,import/no-dynamic-require,@typescript-eslint/no-var-requires
  const {extends: extendedConfig, compilerOptions} = require(tsconfigPath);
  const updatedCompilerOptions = {
    ...compilerOptions,
    ...(previousCompilerOptions ?? {}),
  };
  if (extendedConfig) {
    return extractTsConfig(
      path.resolve(tsconfigPath.replace(/[^/]+$/, ''), extendedConfig),
      updatedCompilerOptions,
    );
  }
  return updatedCompilerOptions;
}

/*
Adapted from https://github.com/aws/aws-cdk/blob/790a709d758333f4622c5fb860d9bbb48dee7106/packages/%40aws-cdk/aws-lambda-nodejs/lib/util.ts#L148
 */
function getTsconfigCompilerOptions(tsconfigPath: string): string {
  const compilerOptions = extractTsConfig(tsconfigPath);
  const excludedCompilerOptions = ['composite', 'tsBuildInfoFile'];

  const options: Record<string, any> = {
    ...compilerOptions,
    incremental: false,
    rootDir: './',
    outDir: './',
  };

  let compilerOptionsString = '';
  Object.keys(options)
    .sort()
    .forEach((key: string) => {
      if (excludedCompilerOptions.includes(key)) {
        return;
      }

      const value = options[key];
      const option = `--${key}`;
      const type = typeof value;

      if (type === 'boolean') {
        if (value) {
          compilerOptionsString += `${option} `;
        } else {
          compilerOptionsString += `${option} false `;
        }
      } else if (type === 'string') {
        compilerOptionsString += `${option} ${value} `;
      } else if (type === 'object') {
        if (Array.isArray(value)) {
          compilerOptionsString += `${option} ${value.join(',')} `;
        }
      } else {
        throw new Error(
          `Missing support for compilerOption: [${key}]: { ${type}, ${value}} \n`,
        );
      }
    });

  return compilerOptionsString.trim();
}

export const watch = async (
  pathGlob: string,
  options: {
    context: string[];
    app: string;
    profile: string;
    logs: boolean;
    skipInitial: boolean;
    forceCloudwatch?: boolean;
  },
): Promise<void> => {
  await runSynth({
    context: options.context || [],
    app: options.app,
    profile: options.profile,
  });

  const manifest = readManifest();
  if (!manifest) throw new Error('cdk-watch manifest file was not found');
  initAwsSdk(manifest.region, options.profile);
  const filteredManifest = filterManifestByPath(pathGlob, manifest);

  const lambdaProgressText = 'resolving lambda configuration';
  twisters.put('lambda', {text: lambdaProgressText});
  resolveLambdaNamesFromManifest(filteredManifest)
    .then((result) => {
      twisters.put('lambda', {
        text: lambdaProgressText,
        active: false,
      });
      return result;
    })
    .then(async (lambdaDetails) => {
      if (options.logs) {
        await tailLogsForLambdas(lambdaDetails, options.forceCloudwatch);
      }
      return Promise.all(
        lambdaDetails.map(
          async ({functionName, lambdaCdkPath, layers, lambdaManifest}) => {
            const {tsconfig, entryPoints} = lambdaManifest.esbuildOptions;
            const entryPointsArray = Array.isArray(entryPoints)
              ? entryPoints
              : Object.values(entryPoints ?? {});
            const filesToWatch = entryPointsArray
              .map((ep) =>
                dependencyTree.toList({
                  filename: ep,
                  directory: path.dirname(tsconfig ?? ''),
                  tsConfig: tsconfig,
                  filter: (filePath) => !filePath.includes('node_modules'),
                }),
              )
              .flat();
            let entryPointsJs: string[] = [];

            if (lambdaManifest.cdkwBuildOptions.preCompilation) {
              entryPointsJs = entryPointsArray.map((ep) =>
                path.format({...path.parse(ep), base: '', ext: '.js'}),
              );
            }

            if (
              lambdaManifest.nodeModulesLayerVersion &&
              !layers.includes(lambdaManifest.nodeModulesLayerVersion)
            ) {
              // eslint-disable-next-line no-console
              console.warn(
                chalk.yellow(
                  '[Warning]: Function modules layer is out of sync with published layer version, this can lead to runtime errors. To fix, do a full `cdk deploy`.',
                ),
              );
            }

            const logger = createCLILoggerForLambda(
              lambdaCdkPath,
              lambdaDetails.length > 1,
            );
            const watchOutdir = copyCdkAssetToWatchOutdir(lambdaManifest);

            const updateFunction = () => {
              const uploadingProgressText = 'uploading function code';

              twisters.put(`${lambdaCdkPath}:uploading`, {
                meta: {prefix: logger.prefix},
                text: uploadingProgressText,
              });

              return updateLambdaFunctionCode(watchOutdir, functionName)
                .then(() => {
                  twisters.put(`${lambdaCdkPath}:uploading`, {
                    meta: {prefix: logger.prefix},
                    text: uploadingProgressText,
                    active: false,
                  });
                })
                .catch((e) => {
                  twisters.put(`${lambdaCdkPath}:uploading`, {
                    text: uploadingProgressText,
                    meta: {error: e},
                    active: false,
                  });
                });
            };

            if (!options.skipInitial) {
              await updateFunction();
            }

            logger.log('waiting for changes');

            const result = await esbuild
              .build({
                ...lambdaManifest.esbuildOptions,
                entryPoints: entryPointsJs ?? entryPointsArray,
                outfile: path.join(watchOutdir, 'index.js'),
                resolveExtensions: lambdaManifest.cdkwBuildOptions
                  .preCompilation
                  ? ['.js']
                  : undefined,
                // Unless explicitly told not to, turn on treeShaking and minify to
                // improve upload times
                treeShaking: lambdaManifest.esbuildOptions.treeShaking ?? true,
                minify: lambdaManifest.esbuildOptions.minify ?? true,
                // Keep the console clean from build warnings, only print errors
                logLevel: lambdaManifest.esbuildOptions.logLevel ?? 'error',
                incremental: true,
              })
              .catch((e: Error) => {
                logger.error(`error building lambda: ${e.toString()}`);
              });

            chokidar.watch(filesToWatch).on('change', async () => {
              if (lambdaManifest.cdkwBuildOptions.preCompilation) {
                const compilingProgressText = 'compiling function code';

                twisters.put(`${lambdaCdkPath}:compiling`, {
                  meta: {prefix: logger.prefix},
                  text: compilingProgressText,
                });

                try {
                  execSync(
                    `tsc  "${entryPointsArray.join(
                      ' ',
                    )}" ${getTsconfigCompilerOptions(tsconfig ?? '')}`,
                  );

                  twisters.put(`${lambdaCdkPath}:compiling`, {
                    meta: {prefix: logger.prefix},
                    text: compilingProgressText,
                    active: false,
                  });
                } catch (err: any) {
                  twisters.put(`${lambdaCdkPath}:compiling`, {
                    meta:
                      lambdaManifest.esbuildOptions.logLevel === 'debug'
                        ? {error: err.message || err.stdout}
                        : {prefix: logger.prefix},
                    text: compilingProgressText,
                    active: false,
                  });
                }
              }
              if (result) {
                await result.rebuild();
              }
              updateFunction();
            });
          },
        ),
      );
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    });
};
