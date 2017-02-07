import tl = require('vsts-task-lib/task');
import tr = require('vsts-task-lib/toolrunner');
import path = require('path');
import Q = require('q');
import models = require('./models')
import taskInputParser = require('./taskInputParser')
import settingsHelper = require('./settingsHelper')
import utilities = require('./utilities')

var os = require('os');
var regedit = require('regedit');
var uuid = require('node-uuid');
var fs = require('fs');
var xml2js = require('xml2js');
var perf = require("performance-now");
var process = require('process');

const runSettingsExt = ".runsettings";
const testSettingsExt = ".testsettings";

let vstestConfig: models.VsTestConfigurations = undefined;
let tiaConfig: models.TiaConfiguration = undefined;
let vsVersionDetails: models.ExecutabaleInfo = undefined;
let vsTestVersionForTIA: number[] = null;
const systemDefaultWorkingDirectory = tl.getVariable('System.DefaultWorkingDirectory');
const workingDirectory = systemDefaultWorkingDirectory;
let testAssemblyFiles = undefined;

export async function startTest() {
    try {
        vstestConfig = taskInputParser.getvsTestConfigurations();
        tiaConfig = vstestConfig.tiaConfig;
        vsVersionDetails = await locateVSVersion(vstestConfig.vsTestVersion);

        testAssemblyFiles = getTestAssemblies();
        if (testAssemblyFiles && testAssemblyFiles.length !== 0) {
            getTestResultsDirectory(vstestConfig.settingsFile, path.join(workingDirectory, 'TestResults'))
                .then(function (resultsDirectory) {
                    invokeVSTest(resultsDirectory)
                        .then(function (code) {
                            try {
                                if (!isTiaAllowed()) {
                                    publishTestResults(resultsDirectory);
                                }
                                tl.setResult(code, tl.loc('VstestReturnCode', code));
                                deleteVstestDiagFile();
                            } catch (error) {
                                deleteVstestDiagFile();
                                tl._writeLine('##vso[task.logissue type=error;code=' + error + ';TaskName=VSTest]');
                                throw error;
                            }
                        })
                        .fail(function (err) {
                            deleteVstestDiagFile();
                            tl._writeLine('##vso[task.logissue type=error;code=' + err + ';TaskName=VSTest]');
                            throw err;
                        });
                });
        } else {
            deleteVstestDiagFile();
            tl._writeLine('##vso[task.logissue type=warning;code=002004;]');
            tl.warning(tl.loc('NoMatchingTestAssemblies', vstestConfig.sourceFilter));
        }
    } catch (error) {
        deleteVstestDiagFile();
        tl._writeLine('##vso[task.logissue type=error;code=' + error + ';TaskName=VSTest]');
        throw error;
    }
}

function getTestAssemblies(): string[] {
    if (isNullOrWhitespace(vstestConfig.testDropLocation)) {
        vstestConfig.testDropLocation = systemDefaultWorkingDirectory;
        tl.debug("Search directory empty, defaulting to " + vstestConfig.testDropLocation);
    }
    tl.debug("Searching for test assemblies in: " + vstestConfig.testDropLocation);
    return tl.findMatch(vstestConfig.testDropLocation, vstestConfig.sourceFilter);
}

function getVsTestVersion(): number[] {
    let vstestLocationEscaped = vsVersionDetails.location.replace(/\\/g, "\\\\");
    let wmicTool = tl.tool("wmic");
    let wmicArgs = ["datafile", "where", "name='".concat(vstestLocationEscaped, "'"), "get", "Version", "/Value"];
    wmicTool.arg(wmicArgs);
    let output = wmicTool.execSync();

    let verSplitArray = output.stdout.split("=");
    if (verSplitArray.length != 2) {
        tl.warning(tl.loc("ErrorReadingVstestVersion"));
        return null;
    }

    let versionArray = verSplitArray[1].split(".");
    if (versionArray.length != 4) {
        tl.warning(tl.loc("UnexpectedVersionString", output.stdout));
        return null;
    }

    let vsVersion: number[] = [];
    vsVersion[0] = parseInt(versionArray[0]);
    vsVersion[1] = parseInt(versionArray[1]);
    vsVersion[2] = parseInt(versionArray[2]);

    if (isNaN(vsVersion[0]) || isNaN(vsVersion[1]) || isNaN(vsVersion[2])) {
        tl.warning(tl.loc("UnexpectedVersionNumber", verSplitArray[1]));
        return null;
    }

    return vsVersion;
}

function getVstestArguments(settingsFile: string, tiaEnabled: boolean): string[] {
    var argsArray: string[] = [];
    testAssemblyFiles.forEach(function (testAssembly) {
        var testAssemblyPath = testAssembly;
        //To maintain parity with the behaviour when test assembly was filepath, try to expand it relative to build sources directory.
        if (systemDefaultWorkingDirectory && !pathExistsAsFile(testAssembly)) {
            var expandedPath = path.join(systemDefaultWorkingDirectory, testAssembly);
            if (pathExistsAsFile(expandedPath)) {
                testAssemblyPath = expandedPath;
            }
        }
        argsArray.push(testAssemblyPath);
    });
    if (vstestConfig.testcaseFilter) {
        if (!tiaEnabled) {
            argsArray.push("/TestCaseFilter:" + vstestConfig.testcaseFilter);
        } else {
            tl.debug("Ignoring TestCaseFilter because Test Impact is enabled");
        }
    }
    if (settingsFile && pathExistsAsFile(settingsFile)) {
        argsArray.push("/Settings:" + settingsFile);
        utilities.readFileContents(settingsFile, "utf-8").then(function (settings) {
        tl.debug("Running VsTest with settings : " + settings);
        });
    }
    if (vstestConfig.codeCoverageEnabled) {
        argsArray.push("/EnableCodeCoverage");
    }    
    if (vstestConfig.runTestsInIsolation) {
        argsArray.push("/InIsolation");
    }

    argsArray.push("/logger:trx");
    if (vstestConfig.pathtoCustomTestAdapters) {
        if (pathExistsAsDirectory(vstestConfig.pathtoCustomTestAdapters)) {
            argsArray.push("/TestAdapterPath:\"" + vstestConfig.pathtoCustomTestAdapters + "\"");
        } else {
            argsArray.push("/TestAdapterPath:\"" + path.dirname(vstestConfig.pathtoCustomTestAdapters) + "\"");
        }
    } else if (systemDefaultWorkingDirectory && isNugetRestoredAdapterPresent(systemDefaultWorkingDirectory)) {
        argsArray.push("/TestAdapterPath:\"" + systemDefaultWorkingDirectory + "\"");
    }

    let sysDebug = tl.getVariable("System.Debug");
    if (sysDebug !== undefined && sysDebug.toLowerCase() === "true") {
        if (vsTestVersionForTIA !== null && (vsTestVersionForTIA[0] > 15 || (vsTestVersionForTIA[0] === 15 && (vsTestVersionForTIA[1] > 0 || vsTestVersionForTIA[2] > 25428)))) {
            argsArray.push("/diag:" + vstestConfig.vstestDiagFile);
        } else {
            tl.warning(tl.loc("VstestDiagNotSupported"));
        }
    }

    return argsArray;
}

function addVstestArgs(argsArray: string[], vstest: any) {
    argsArray.forEach(function (arr) {
        vstest.arg(arr);
    });
}

function updateResponseFile(argsArray: string[], responseFile: string): Q.Promise<string> {
    var defer = Q.defer<string>();
    argsArray.forEach(function (arr, i) {
        if (!arr.startsWith('/')) {
            argsArray[i] = "\"" + arr + "\"";
        }
    });
    fs.appendFile(responseFile, os.EOL + argsArray.join(os.EOL), function (err) {
        if (err) {
            defer.reject(err);
        }
        defer.resolve(responseFile);
    });
    return defer.promise;
}

function getTestSelectorLocation(): string {
    return path.join(__dirname, "TestSelector/TestSelector.exe");
}

function uploadTestResults(testResultsDirectory: string): Q.Promise<string> {
    var startTime = perf();
    var endTime;
    var elapsedTime;
    var definitionRunId: string;
    var resultFile: string;
    var defer = Q.defer<string>();
    var allFilesInResultsDirectory;
    var resultFiles;
    if (!isNullOrWhitespace(testResultsDirectory)) {
        resultFiles = tl.findMatch(testResultsDirectory, path.join(testResultsDirectory, "*.trx"));
    }

    var selectortool = tl.tool(getTestSelectorLocation());
    selectortool.arg("UpdateTestResults");

    if (tiaConfig.context === "CD") {
        definitionRunId = tl.getVariable("Release.ReleaseId");
    } else {
        definitionRunId = tl.getVariable("Build.BuildId");
    }

    if (resultFiles && resultFiles[0]) {
        resultFile = resultFiles[0];
    }

    selectortool.exec({
        cwd: null,
        env: {
            "collectionurl": tl.getVariable("System.TeamFoundationCollectionUri"),
            "projectid": tl.getVariable("System.TeamProject"),
            "definitionrunid": definitionRunId,
            "token": tl.getEndpointAuthorizationParameter("SystemVssConnection", "AccessToken", false),
            "resultfile": resultFile,
            "runidfile": tiaConfig.runIdFile,
            "context": tiaConfig.context,
        },
        silent: null,
        failOnStdErr: null,
        ignoreReturnCode: null,
        outStream: null,
        errStream: null,
        windowsVerbatimArguments: null
    })
        .then(function (code) {
            endTime = perf();
            elapsedTime = endTime - startTime;
            tl._writeLine("##vso[task.logissue type=warning;SubTaskName=UploadTestResults;SubTaskDuration=" + elapsedTime + "]");
            tl.debug(tl.loc("UploadTestResultsPerfTime", elapsedTime));
            defer.resolve(String(code));
        })
        .fail(function (err) {
            defer.reject(err);
        });
    return defer.promise;
}

function generateResponseFile(discoveredTests: string): Q.Promise<string> {
    var startTime = perf();
    var endTime: number;
    var elapsedTime: number;
    var definitionRunId: string;
    var title: string;
    var platformInput: string;
    var configurationInput: string;
    var defer = Q.defer<string>();
    var respFile = path.join(os.tmpdir(), uuid.v1() + ".txt");
    tl.debug("Response file will be generated at " + respFile);
    tl.debug("RunId file will be generated at " + tiaConfig.runIdFile);
    var selectortool = tl.tool(getTestSelectorLocation());
    selectortool.arg("GetImpactedtests");

    if (tiaConfig.context === "CD") {
        // Release context. Passing Release Id.
        definitionRunId = tl.getVariable("Release.ReleaseId");
    } else {
        // Build context. Passing build id.
        definitionRunId = tl.getVariable("Build.BuildId");
    }

    if (vstestConfig.buildPlatform) {
        platformInput = vstestConfig.buildPlatform;
    } else {
        platformInput = "";
    }

    if (vstestConfig.testRunTitle) {
        title = vstestConfig.testRunTitle;
    } else {
        title = "";
    }

    if (vstestConfig.buildConfig) {
        configurationInput = vstestConfig.buildConfig;
    } else {
        configurationInput = "";
    }

    selectortool.exec({
        cwd: null,
        env: {
            "collectionurl": tl.getVariable("System.TeamFoundationCollectionUri"),
            "projectid": tl.getVariable("System.TeamProject"),
            "definitionrunid": definitionRunId,
            "releaseuri": tl.getVariable("release.releaseUri"),
            "releaseenvuri": tl.getVariable("release.environmentUri"),
            "token": tl.getEndpointAuthorizationParameter("SystemVssConnection", "AccessToken", false),
            "responsefilepath": respFile,
            "discoveredtestspath": discoveredTests,
            "runidfilepath": tiaConfig.runIdFile,
            "testruntitle": title,
            "baselinebuildfilepath": tiaConfig.baseLineBuildIdFile,
            "context": tiaConfig.context,
            "platform": platformInput,
            "configuration": configurationInput
        },
        silent: null,
        failOnStdErr: null,
        ignoreReturnCode: null,
        outStream: null,
        errStream: null,
        windowsVerbatimArguments: null
    })
        .then(function (code) {
            endTime = perf();
            elapsedTime = endTime - startTime;
            tl.debug(tl.loc("GenerateResponseFilePerfTime", elapsedTime));
            defer.resolve(respFile);
        })
        .fail(function (err) {
            defer.reject(err);
        });

    return defer.promise;
}

function publishCodeChanges(): Q.Promise<string> {
    var startTime = perf();
    var endTime: number;
    var elapsedTime: number;
    var pathFilters: string;
    var definitionRunId: string;
    var definitionId: string;
    var prFlow: string;
    var rebaseLimit: string;
    var sourcesDirectory: string;
    var defer = Q.defer<string>();

    var newprovider = "true";
    if (getTIALevel() === 'method') {
        newprovider = "false";
    }

    var selectortool = tl.tool(getTestSelectorLocation());
    selectortool.arg("PublishCodeChanges");

    if (tiaConfig.context === "CD") {
        // Release context. Passing Release Id.
        definitionRunId = tl.getVariable("Release.ReleaseId");
        definitionId = tl.getVariable("release.DefinitionId");
    } else {
        // Build context. Passing build id.
        definitionRunId = tl.getVariable("Build.BuildId");
        definitionId = tl.getVariable("System.DefinitionId");
    }

    if (tiaConfig.isPrFlow && tiaConfig.isPrFlow.toUpperCase() === "TRUE") {
        prFlow = "true";
    } else {
        prFlow = "false";
    }

    if (tiaConfig.tiaRebaseLimit) {
        rebaseLimit = tiaConfig.tiaRebaseLimit;
    }

    if (typeof tiaConfig.tiaFilterPaths != 'undefined') {
        pathFilters = tiaConfig.tiaFilterPaths.trim();
    } else {
        pathFilters = "";
    }

    if (typeof tiaConfig.sourcesDir != 'undefined') {
        sourcesDirectory = tiaConfig.sourcesDir.trim();
    } else {
        sourcesDirectory = "";
    }

    selectortool.exec({
        cwd: null,
        env: {
            "collectionurl": tl.getVariable("System.TeamFoundationCollectionUri"),
            "projectid": tl.getVariable("System.TeamProject"),
            "definitionrunid": definitionRunId,
            "definitionid": definitionId,
            "token": tl.getEndpointAuthorizationParameter("SystemVssConnection", "AccessToken", false),
            "sourcesdir": sourcesDirectory,
            "newprovider": newprovider,
            "prflow": prFlow,
            "rebaselimit": rebaseLimit,
            "baselinefile": tiaConfig.baseLineBuildIdFile,
            "context": tiaConfig.context,
            "filter": pathFilters
        },
        silent: null,
        failOnStdErr: null,
        ignoreReturnCode: null,
        outStream: null,
        errStream: null,
        windowsVerbatimArguments: null
    })
        .then(function (code) {
            endTime = perf();
            elapsedTime = endTime - startTime;
            tl.debug(tl.loc("PublishCodeChangesPerfTime", elapsedTime));
            defer.resolve(String(code));
        })
        .fail(function (err) {
            defer.reject(err);
        });

    return defer.promise;
}

function getVSTestLocation(vsVersion: number): string {
    let vsCommon: string = tl.getVariable('VS' + vsVersion + '0COMNTools');
    if (!vsCommon) {
        throw (new Error(tl.loc('VstestNotFound', vsVersion)));
    } else {
        return path.join(vsCommon, '..\\IDE\\CommonExtensions\\Microsoft\\TestWindow\\vstest.console.exe');
    }
}

function executeVstest(testResultsDirectory: string, parallelRunSettingsFile: string, vsVersion: number, argsArray: string[]): Q.Promise<number> {
    var defer = Q.defer<number>();
    var vstest = tl.tool(vsVersionDetails.location);
    addVstestArgs(argsArray, vstest);

    tl.rmRF(testResultsDirectory, true);
    tl.mkdirP(testResultsDirectory);
    tl.cd(workingDirectory);
    var ignoreTestFailures = vstestConfig.ignoreVstestFailure && vstestConfig.ignoreVstestFailure.toLowerCase() === "true";
    vstest.exec(<tr.IExecOptions>{ failOnStdErr: !ignoreTestFailures })
        .then(function (code) {
            cleanUp(parallelRunSettingsFile);
            defer.resolve(code);
        })
        .fail(function (err) {
            cleanUp(parallelRunSettingsFile);
            tl.warning(tl.loc('VstestFailed'));
            if (ignoreTestFailures) {
                tl.warning(err);
                defer.resolve(0);
            } else {
                tl.error(err);
                defer.resolve(1);
            }
        });
    return defer.promise;
}

function getVstestTestsList(vsVersion: number): Q.Promise<string> {
    var defer = Q.defer<string>();
    var tempFile = path.join(os.tmpdir(), uuid.v1() + ".txt");
    tl.debug("Discovered tests listed at: " + tempFile);
    var argsArray: string[] = [];

    testAssemblyFiles.forEach(function (testAssembly) {
        var testAssemblyPath = testAssembly;
        if (systemDefaultWorkingDirectory && !pathExistsAsFile(testAssembly)) {
            var expandedPath = path.join(systemDefaultWorkingDirectory, testAssembly);
            if (pathExistsAsFile(expandedPath)) {
                testAssemblyPath = expandedPath;
            }
        }
        argsArray.push(testAssemblyPath);
    });

    tl.debug("The list of discovered tests is generated at " + tempFile);

    argsArray.push("/ListFullyQualifiedTests");
    argsArray.push("/ListTestsTargetPath:" + tempFile);
    if (vstestConfig.testcaseFilter) {
        argsArray.push("/TestCaseFilter:" + vstestConfig.testcaseFilter);
    }
    if (vstestConfig.pathtoCustomTestAdapters) {
        if (pathExistsAsDirectory(vstestConfig.pathtoCustomTestAdapters)) {
            argsArray.push("/TestAdapterPath:\"" + vstestConfig.pathtoCustomTestAdapters + "\"");
        } else {
            argsArray.push("/TestAdapterPath:\"" + path.dirname(vstestConfig.pathtoCustomTestAdapters) + "\"");
        }
    } else if (systemDefaultWorkingDirectory && isNugetRestoredAdapterPresent(systemDefaultWorkingDirectory)) {
        argsArray.push("/TestAdapterPath:\"" + systemDefaultWorkingDirectory + "\"");
    }

    if (vstestConfig.pathtoCustomTestAdapters && vstestConfig.pathtoCustomTestAdapters.toLowerCase().indexOf("usevsixextensions:true") != -1) {
        argsArray.push("/UseVsixExtensions:true");
    }

    let vstest = tl.tool(vsVersionDetails.location);
    addVstestArgs(argsArray, vstest);

    tl.cd(workingDirectory);
    vstest.exec(<tr.IExecOptions>{ failOnStdErr: true })
        .then(function (code) {
            defer.resolve(tempFile);
        })
        .fail(function (err) {
            tl.debug("Listing tests from VsTest failed.");
            tl.error(err);
            defer.resolve(err);
        });
    return defer.promise;
}

function cleanFiles(responseFile: string, listFile: string): void {
    tl.debug("Deleting the response file " + responseFile);
    tl.rmRF(responseFile, true);
    tl.debug("Deleting the discovered tests file " + listFile);
    tl.rmRF(listFile, true);
    tl.debug("Deleting the baseline build id file " + tiaConfig.baseLineBuildIdFile);
    tl.rmRF(tiaConfig.baseLineBuildIdFile, true);
}

function deleteVstestDiagFile(): void {
    if (pathExistsAsFile(vstestConfig.vstestDiagFile)) {
        tl.debug("Deleting vstest diag file " + vstestConfig.vstestDiagFile);
        tl.rmRF(vstestConfig.vstestDiagFile, true);
    }
}

function runVStest(testResultsDirectory: string, settingsFile: string, vsVersion: number): Q.Promise<number> {
    var defer = Q.defer<number>();
    if (isTiaAllowed()) {
        publishCodeChanges()
            .then(function (status) {
                getVstestTestsList(vsVersion)
                    .then(function (listFile) {
                        generateResponseFile(listFile)
                            .then(function (responseFile) {
                                if (isEmptyResponseFile(responseFile)) {
                                    tl.debug("Empty response file detected. All tests will be executed.");
                                    executeVstest(testResultsDirectory, settingsFile, vsVersion, getVstestArguments(settingsFile, false))
                                        .then(function (vscode) {
                                            uploadTestResults(testResultsDirectory)
                                                .then(function (code) {
                                                    if (!isNaN(+code) && +code != 0) {
                                                        defer.resolve(+code);
                                                    } else if (vscode != 0) {
                                                        defer.resolve(vscode);
                                                    }

                                                    defer.resolve(0);
                                                })
                                                .fail(function (code) {
                                                    tl.debug("Test Run Updation failed!");
                                                    defer.resolve(1);
                                                })
                                                .finally(function () {
                                                    cleanFiles(responseFile, listFile);
                                                    tl.debug("Deleting the run id file" + tiaConfig.runIdFile);
                                                    tl.rmRF(tiaConfig.runIdFile, true);
                                                });
                                        })
                                        .fail(function (code) {
                                            defer.resolve(code);
                                        })
                                        .finally(function () {
                                            cleanFiles(responseFile, listFile);
                                        });
                                } else {
                                    responseContainsNoTests(responseFile)
                                        .then(function (noTestsAvailable) {
                                            if (noTestsAvailable) {
                                                tl.debug("No tests impacted. Not running any tests.");
                                                uploadTestResults("")
                                                    .then(function (code) {
                                                        if (!isNaN(+code) && +code != 0) {
                                                            defer.resolve(+code);
                                                        }
                                                        defer.resolve(0);
                                                    })
                                                    .fail(function (code) {
                                                        tl.debug("Test Run Updation failed!");
                                                        defer.resolve(1);
                                                    })
                                                    .finally(function () {
                                                        cleanFiles(responseFile, listFile);
                                                        tl.debug("Deleting the run id file" + tiaConfig.runIdFile);
                                                        tl.rmRF(tiaConfig.runIdFile, true);
                                                    });
                                            } else {
                                                updateResponseFile(getVstestArguments(settingsFile, true), responseFile)
                                                    .then(function (updatedFile) {
                                                        executeVstest(testResultsDirectory, settingsFile, vsVersion, ["@" + updatedFile])
                                                            .then(function (vscode) {
                                                                uploadTestResults(testResultsDirectory)
                                                                    .then(function (code) {
                                                                        if (!isNaN(+code) && +code != 0) {
                                                                            defer.resolve(+code);
                                                                        } else if (vscode != 0) {
                                                                            defer.resolve(vscode);
                                                                        }

                                                                        defer.resolve(0);
                                                                    })
                                                                    .fail(function (code) {
                                                                        tl.debug("Test Run Updation failed!");
                                                                        defer.resolve(1);
                                                                    })
                                                                    .finally(function () {
                                                                        cleanFiles(responseFile, listFile);
                                                                        tl.debug("Deleting the run id file" + tiaConfig.runIdFile);
                                                                        tl.rmRF(tiaConfig.runIdFile, true);
                                                                    });
                                                            })
                                                            .fail(function (code) {
                                                                defer.resolve(code);
                                                            })
                                                            .finally(function () {
                                                                cleanFiles(responseFile, listFile);
                                                            });
                                                    })
                                                    .fail(function (err) {
                                                        tl.error(err);
                                                        tl.warning(tl.loc('ErrorWhileUpdatingResponseFile', responseFile));
                                                        executeVstest(testResultsDirectory, settingsFile, vsVersion, getVstestArguments(settingsFile, false))
                                                            .then(function (vscode) {
                                                                uploadTestResults(testResultsDirectory)
                                                                    .then(function (code) {
                                                                        if (!isNaN(+code) && +code != 0) {
                                                                            defer.resolve(+code);
                                                                        } else if (vscode != 0) {
                                                                            defer.resolve(vscode);
                                                                        }

                                                                        defer.resolve(0);
                                                                    })
                                                                    .fail(function (code) {
                                                                        tl.debug("Test Run Updation failed!");
                                                                        defer.resolve(1);
                                                                    })
                                                                    .finally(function () {
                                                                        cleanFiles(responseFile, listFile);
                                                                        tl.debug("Deleting the run id file" + tiaConfig.runIdFile);
                                                                        tl.rmRF(tiaConfig.runIdFile, true);
                                                                    });
                                                            })
                                                            .fail(function (code) {
                                                                defer.resolve(code);
                                                            }).finally(function () {
                                                                cleanFiles(responseFile, listFile);
                                                            });
                                                    })
                                                    .fail(function (err) {
                                                        tl.error(err)
                                                        defer.resolve(1);
                                                    });
                                            }
                                        })
                                        .fail(function (err) {
                                            tl.error(err)
                                            defer.resolve(1);
                                        });
                                }
                            })
                            .fail(function (err) {
                                tl.error(err);
                                tl.warning(tl.loc('ErrorWhileCreatingResponseFile'));
                                executeVstest(testResultsDirectory, settingsFile, vsVersion, getVstestArguments(settingsFile, false))
                                    .then(function (vscode) {
                                        uploadTestResults(testResultsDirectory)
                                            .then(function (code) {
                                                if (!isNaN(+code) && +code != 0) {
                                                    defer.resolve(+code);
                                                } else if (vscode != 0) {
                                                    defer.resolve(vscode);
                                                }

                                                defer.resolve(0);
                                            })
                                            .fail(function (code) {
                                                tl.debug("Test Run Updation failed!");
                                                defer.resolve(1);
                                            })
                                            .finally(function () {
                                                tl.debug("Deleting the discovered tests file" + listFile);
                                                tl.rmRF(listFile, true);
                                            });
                                    })
                                    .fail(function (code) {
                                        defer.resolve(code);
                                    });
                            })
                            .fail(function (err) {
                                tl.error(err)
                                defer.resolve(1);
                            });
                    })
                    .fail(function (err) {
                        tl.error(err);
                        tl.warning(tl.loc('ErrorWhileListingDiscoveredTests'));
                        defer.resolve(1);
                    });
            })
            .fail(function (err) {
                tl.error(err);
                tl.warning(tl.loc('ErrorWhilePublishingCodeChanges'));
                executeVstest(testResultsDirectory, settingsFile, vsVersion, getVstestArguments(settingsFile, false))
                    .then(function (code) {
                        publishTestResults(testResultsDirectory);
                        defer.resolve(code);
                    })
                    .fail(function (code) {
                        defer.resolve(code);
                    });
            });
    } else {
        tl.debug("Non TIA mode of test execution");
        executeVstest(testResultsDirectory, settingsFile, vsVersion, getVstestArguments(settingsFile, false))
            .then(function (code) {
                defer.resolve(code);
            })
            .fail(function (code) {
                defer.resolve(code);
            });
    }
    return defer.promise;
}

function invokeVSTest(testResultsDirectory: string): Q.Promise<number> {
    var defer = Q.defer<number>();
    if (vstestConfig.vsTestVersion && vstestConfig.vsTestVersion.toLowerCase() === "latest") {
        vstestConfig.vsTestVersion = null;
    }
    overrideTestRunParametersIfRequired(vstestConfig.settingsFile)
        .then(function (overriddenSettingsFile) {
            let vsVersion = vsVersionDetails.version;
            try {
                let disableTIA = tl.getVariable("DisableTestImpactAnalysis");
                if (disableTIA !== undefined && disableTIA.toLowerCase() === "true") {
                    tiaConfig.tiaEnabled = false;
                }
                let sysDebug = tl.getVariable("System.Debug");
                if ((sysDebug !== undefined && sysDebug.toLowerCase() === "true") || tiaConfig.tiaEnabled) {
                    vsTestVersionForTIA = getVsTestVersion();

                    if (tiaConfig.tiaEnabled && (vsTestVersionForTIA === null || (vsTestVersionForTIA[0] < 15 || (vsTestVersionForTIA[0] === 15 && vsTestVersionForTIA[1] === 0 && vsTestVersionForTIA[2] < 25727)))) {
                        tl.warning(tl.loc("VstestTIANotSupported"));
                        tiaConfig.tiaEnabled = false;
                    }
                }
            } catch (e) {
                tl.error(e.message);
                defer.resolve(1);
                return defer.promise;
            }            
            setRunInParallellIfApplicable(vsVersion);
            var newSettingsFile = overriddenSettingsFile;
            try {
                settingsHelper.updateSettingsFileAsRequired(overriddenSettingsFile, vstestConfig.runInParallel, vstestConfig.tiaConfig, false).
                then(function(ret) {
                    newSettingsFile = ret;
                    if(newSettingsFile != overriddenSettingsFile) {
                    cleanUp(overriddenSettingsFile);
                    }
                    runVStest(testResultsDirectory, newSettingsFile, vsVersion)
                    .then(function (code) {
                        defer.resolve(code);
                    })
                    .fail(function (code) {
                        defer.resolve(code);
                    });
                    
                })                               
            } catch (error) {
                tl.warning(tl.loc('ErrorWhileUpdatingSettings'));
                tl.debug(error);
                //Should continue to run without the selected configurations.
                runVStest(testResultsDirectory, newSettingsFile, vsVersion)
                    .then(function (code) {
                        defer.resolve(code);
                    })
                    .fail(function (code) {
                        defer.resolve(code);
                    });
            }
        })
        .fail(function (err) {
            tl.error(err);
            defer.resolve(1);
        });

    return defer.promise;
}

function publishTestResults(testResultsDirectory: string) {
    if (testResultsDirectory) {
        let resultFiles = tl.findMatch(testResultsDirectory, path.join(testResultsDirectory, "*.trx"));

        if (resultFiles && resultFiles.length != 0) {
            var tp = new tl.TestPublisher("VSTest");
            tp.publish(resultFiles, "false", vstestConfig.buildPlatform, vstestConfig.buildConfig, vstestConfig.testRunTitle, vstestConfig.publishRunAttachments);
        } else {
            tl._writeLine("##vso[task.logissue type=warning;code=002003;]");
            tl.warning(tl.loc('NoResultsToPublish'));
        }
    }
}

function cleanUp(temporarySettingsFile: string) {
    //cleanup the runsettings file
    if (temporarySettingsFile && vstestConfig.settingsFile != temporarySettingsFile) {
        try {
            tl.rmRF(temporarySettingsFile, true);
        } catch (error) {
            //ignore. just cleanup.
        }
    }
}

function overrideTestRunParametersIfRequired(settingsFile: string): Q.Promise<string> {
    var defer = Q.defer<string>();
    if (!settingsFile || !pathExistsAsFile(settingsFile) || !vstestConfig.overrideTestrunParameters || vstestConfig.overrideTestrunParameters.trim().length === 0) {
        defer.resolve(settingsFile);
        return defer.promise;
    }

    vstestConfig.overrideTestrunParameters = vstestConfig.overrideTestrunParameters.trim();
    var overrideParameters = {};

    var parameterStrings = vstestConfig.overrideTestrunParameters.split(";");
    parameterStrings.forEach(function (parameterString) {
        var pair = parameterString.split("=", 2);
        if (pair.length === 2) {
            var key = pair[0];
            var value = pair[1];
            if (!overrideParameters[key]) {
                overrideParameters[key] = value;
            }
        }
    });

    utilities.readFileContents(vstestConfig.settingsFile, "utf-8")
        .then(function (xmlContents) {
            var parser = new xml2js.Parser();
            parser.parseString(xmlContents, function (err, result) {
                if (err) {
                    tl.warning(tl.loc('ErrorWhileReadingRunSettings', err));
                    tl.debug("Error occured while overriding test run parameters. Continuing...");
                    defer.resolve(settingsFile);
                    return defer.promise;
                }

                if (result.RunSettings && result.RunSettings.TestRunParameters && result.RunSettings.TestRunParameters[0] &&
                    result.RunSettings.TestRunParameters[0].Parameter) {
                    var parametersArray = result.RunSettings.TestRunParameters[0].Parameter;
                    parametersArray.forEach(function (parameter) {
                        var key = parameter.$.name;
                        if (overrideParameters[key]) {
                            parameter.$.value = overrideParameters[key];
                        }
                    });
                    tl.debug("Overriding test run parameters.");
                    var builder = new xml2js.Builder();
                    var overridedRunSettings = builder.buildObject(result);
                    utilities.saveToFile(overridedRunSettings, runSettingsExt)
                        .then(function (fileName) {
                            defer.resolve(fileName);
                        })
                        .fail(function (err) {
                            tl.debug("Error occured while overriding test run parameters. Continuing...");
                            tl.warning(err);
                            defer.resolve(settingsFile);
                        });
                } else {
                    tl.debug("No test run parameters found to override.");
                    defer.resolve(settingsFile);
                }
            });
        })
        .fail(function (err) {
            tl.debug("Error occured while overriding test run parameters. Continuing...");
            tl.warning(err);
            defer.resolve(settingsFile);
        });
    return defer.promise;
}

function isNugetRestoredAdapterPresent(rootDirectory: string): boolean {
    var allFiles = tl.find(rootDirectory);
    var adapterFiles = tl.match(allFiles, "**\\packages\\**\\*TestAdapter.dll", { matchBase: true });
    if (adapterFiles && adapterFiles.length != 0) {
        for (var i = 0; i < adapterFiles.length; i++) {
            var adapterFile = adapterFiles[i];
            var packageIndex = adapterFile.indexOf('packages') + 7;
            var packageFolder = adapterFile.substr(0, packageIndex);
            var parentFolder = path.dirname(packageFolder);
            var solutionFiles = tl.match(allFiles, path.join(parentFolder, "*.sln"), { matchBase: true });
            if (solutionFiles && solutionFiles.length != 0) {
                return true;
            }
        }
    }
    return false;
}

function getTestResultsDirectory(settingsFile: string, defaultResultsDirectory: string): Q.Promise<string> {
    var defer = Q.defer<string>();
    if (!settingsFile || !pathExistsAsFile(settingsFile)) {
        defer.resolve(defaultResultsDirectory);
        return defer.promise;
    }

    utilities.readFileContents(vstestConfig.settingsFile, "utf-8")
        .then(function (xmlContents) {
            var parser = new xml2js.Parser();
            parser.parseString(xmlContents, function (err, result) {
                if (!err && result.RunSettings && result.RunSettings.RunConfiguration && result.RunSettings.RunConfiguration[0] &&
                    result.RunSettings.RunConfiguration[0].ResultsDirectory && result.RunSettings.RunConfiguration[0].ResultsDirectory[0].length > 0) {
                    var resultDirectory = result.RunSettings.RunConfiguration[0].ResultsDirectory[0];
                    resultDirectory = resultDirectory.trim();

                    if (resultDirectory) {
                        // path.resolve will take care if the result directory given in settings files is not absolute.
                        defer.resolve(path.resolve(path.dirname(vstestConfig.settingsFile), resultDirectory));
                    }
                    else {
                        defer.resolve(defaultResultsDirectory);
                    }
                }
                else {
                    defer.resolve(defaultResultsDirectory);
                }
            });
        })
        .fail(function (err) {
            tl.debug("Error occured while reading test result directory from run settings. Continuing...")
            tl.warning(err);
            defer.resolve(defaultResultsDirectory);
        });
    return defer.promise;
}

function setRunInParallellIfApplicable(vsVersion: number) {
    if (vstestConfig.runInParallel) {
        if (!isNaN(vsVersion) && vsVersion >= 14) {
            if (vsVersion >= 15) { // moved away from taef
                return;
            }

            // in 14.0 taef parellization needed taef enabled
            let vs14Common: string = tl.getVariable("VS140COMNTools");
            if (vs14Common && pathExistsAsFile(path.join(vs14Common, "..\\IDE\\CommonExtensions\\Microsoft\\TestWindow\\TE.TestModes.dll"))) {
                setRegistryKeyForParallelExecution(vsVersion);
                return;
            }
        }
        resetRunInParallel();
    }
}

function resetRunInParallel() {
    tl.warning(tl.loc('UpdateOneOrHigherRequired'));
    vstestConfig.runInParallel = false;
}


function getLatestVSTestConsolePathFromRegistry(): Q.Promise<models.ExecutabaleInfo> {
    let deferred = Q.defer<models.ExecutabaleInfo>();
    let regPath = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio';
    regedit.list(regPath).on('data', (entry) => {
        let subkeys = entry.data.keys;
        let versions = getFloatsFromStringArray(subkeys);
        if (versions && versions.length > 0) {
            versions.sort((a, b) => a - b);
            let selectedVersion = versions[versions.length - 1];
            tl.debug('Registry entry found. Selected version is ' + selectedVersion.toString());
            deferred.resolve({ version: selectedVersion, location: getVSTestLocation(selectedVersion) });
        } else {
            deferred.resolve(null);
        }
    }).on('error', () => {
        tl.debug('Registry entry not found under VisualStudio node');
        deferred.resolve(null);
    });
    return deferred.promise;
}

function getVSTestConsole15Path(): string {
    let powershellTool = tl.tool('powershell');
    let powershellArgs = ['-file', vstestConfig.vs15HelperPath]
    powershellTool.arg(powershellArgs);
    let xml = powershellTool.execSync().stdout;
    let deferred = Q.defer<string>();
    let vstestconsolePath: string = null;
    xml2js.parseString(xml, (err, result) => {
        if (result) {
            try {
                let vs15InstallDir = result['Objs']['S'][0];
                vstestconsolePath = path.join(vs15InstallDir, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'TestWindow', 'vstest.console.exe');
            } catch (e) {
                tl.debug('Unable to read Visual Studio 2017 installation path');
                tl.debug(e);
                vstestconsolePath = null;
            }
        }
    })
    return vstestconsolePath;
}


function locateVSVersion(version: string): Q.Promise<models.ExecutabaleInfo> {
    let deferred = Q.defer<models.ExecutabaleInfo>();
    let vsVersion: number = parseFloat(version);

    if (isNaN(vsVersion) || vsVersion === 15) {
        // latest
        tl.debug('Searching for latest Visual Studio');
        let vstestconsole15Path = getVSTestConsole15Path();
        if (vstestconsole15Path) {
            deferred.resolve({ version: 15, location: vstestconsole15Path });
        } else {
            // fallback
            tl.debug('Unable to find an instance of Visual Studio 2017');
            return getLatestVSTestConsolePathFromRegistry();
        }
    } else {
        tl.debug('Searching for Visual Studio ' + vsVersion.toString());
        deferred.resolve({ version: vsVersion, location: getVSTestLocation(vsVersion) });
    }
    return deferred.promise;
}

function getFloatsFromStringArray(inputArray: string[]): number[] {
    var outputArray: number[] = [];
    var count;
    if (inputArray) {
        for (count = 0; count < inputArray.length; count++) {
            var floatValue = parseFloat(inputArray[count]);
            if (!isNaN(floatValue)) {
                outputArray.push(floatValue);
            }
        }
    }
    return outputArray;
}

function setRegistryKeyForParallelExecution(vsVersion: number) {
    var regKey = "HKCU\\SOFTWARE\\Microsoft\\VisualStudio\\" + vsVersion.toFixed(1) + "_Config\\FeatureFlags\\TestingTools\\UnitTesting\\Taef";
    regedit.createKey(regKey, function (err) {
        if (!err) {
            var values = {
                [regKey]: {
                    'Value': {
                        value: '1',
                        type: 'REG_DWORD'
                    }
                }
            };
            regedit.putValue(values, function (err) {
                if (err) {
                    tl.warning(tl.loc('ErrorOccuredWhileSettingRegistry', err));
                }
            });
        } else {
            tl.warning(tl.loc('ErrorOccuredWhileSettingRegistry', err));
        }
    });
}

function pathExistsAsFile(path: string) {
    return tl.exist(path) && tl.stats(path).isFile();
}

function pathExistsAsDirectory(path: string) {
    return tl.exist(path) && tl.stats(path).isDirectory();
}

function isEmptyResponseFile(responseFile: string): boolean {
    if (pathExistsAsFile(responseFile) && tl.stats(responseFile).size) {
        return false;
    }
    return true;
}

function isTiaAllowed(): boolean {
    if (tiaConfig.tiaEnabled && getTestSelectorLocation()) {
        return true;
    }
    return false;
}

function getTIALevel() {
    if (tiaConfig.fileLevel && tiaConfig.fileLevel.toUpperCase() === "FALSE") {
        return "method";
    }
    return "file";
}

function responseContainsNoTests(filePath: string): Q.Promise<boolean> {
    return utilities.readFileContents(filePath, "utf-8").then(function (resp) {
        if (resp === "/Tests:") {
            return true;
        }
        else {
            return false;
        }
    });
}

function isNullOrWhitespace(input) {
    if (typeof input === 'undefined' || input === null) {
        return true;
    }
    return input.replace(/\s/g, '').length < 1;
}