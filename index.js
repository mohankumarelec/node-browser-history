const path = require("path");
const fs = require("fs");
const Database = require("sqlite-async");
const uuidV4 = require("uuid").v4;
const moment = require("moment");

const browsers = require("./browsers");


/**
 * Runs the the proper function for the given browser. Some browsers follow the same standards as
 * chrome and firefox others have their own syntax.
 * Returns an empty array or an array of browser record objects
 * @param paths
 * @param browserName
 * @param historyTimeLength
 * @returns {Promise<array>}
 */
async function getBrowserHistory(paths = [], browserName, historyTimeLength) {
    switch (browserName) {
        case browsers.FIREFOX:
        case browsers.SEAMONKEY:
            return getMozillaBasedBrowserRecords(paths, browserName, historyTimeLength);
        case browsers.CHROME:
        case browsers.OPERA:
        case browsers.TORCH:
        case browsers.VIVALDI:
        case browsers.BRAVE:
            return await getChromeBasedBrowserRecords(paths, browserName, historyTimeLength);

        case browsers.MAXTHON:
            return await getMaxthonBasedBrowserRecords(paths, browserName, historyTimeLength);

        case browsers.SAFARI:
            return await getSafariBasedBrowserRecords(paths, browserName, historyTimeLength);

        case browsers.INTERNETEXPLORER:
            //Only do this on Windows we have to do t his here because the DLL manages this
            if (process.platform !== "win32") {
                return [];
            }
            return await getInternetExplorerBasedBrowserRecords(historyTimeLength);

        default:
            return [];
    }
}
async function getHistoryFromDb(dbPath, newDbPath, sql, browserName){
    //Assuming the sqlite file is locked so lets make a copy of it
    fs.copyFileSync(dbPath, newDbPath);
    const db = await Database.open(newDbPath)
    const rows = await db.all(sql)
    console.log(rows)
    let browserHistory = rows.map(row => {
        return {
            title: row.title,
            utc_time: row.last_visit_time,
            url: row.url,
            browser: browserName,
        };
    });
    await db.close()
    return browserHistory;
}

async function getChromeBasedBrowserRecords(paths, browserName, historyTimeLength) {
    if (!paths || paths.length === 0) {
        return [];
    }
    let newDbPaths = [];
    let browserHistory = [];
    for (let p in paths) {
        if (paths.hasOwnProperty(p) && paths[p] !== "") {
            let newDbPath = path.join(process.env.TMP ? process.env.TMP : process.env.TMPDIR, uuidV4() + ".sqlite");
            newDbPaths.push(newDbPath)
            let sql = `SELECT title, datetime(last_visit_time/1000000 + (strftime('%s', '1601-01-01')),'unixepoch') last_visit_time, url from urls WHERE DATETIME (last_visit_time/1000000 + (strftime('%s', '1601-01-01')), 'unixepoch')  >= DATETIME('now', '-${historyTimeLength} minutes')`;
            //Assuming the sqlite file is locked so lets make a copy of it
            fs.copyFileSync(paths[p], newDbPath);
            console.log(newDbPath)
            browserHistory.push(await getHistoryFromDb(paths[p], newDbPath, sql, browserName))
        }
    }
    deleteTempFiles(newDbPaths);
    return browserHistory;
}

function deleteTempFiles(paths){
    paths.forEach(path=>{
        fs.unlinkSync(path);
    })
}


async function getMozillaBasedBrowserRecords(paths, browserName, historyTimeLength) {
    if (!paths || paths.length === 0) {
        return [];
    }
    let newDbPaths = [];
    let browserHistory = [];
    for (let i = 0; i < paths.length; i++) {
        if (paths[i] || paths[i] !== "") {
            const db = await Database.open(paths[i])
            try{

            //Flush Memory Changes to Disk
            await db.run('PRAGMA wal_checkpoint(FULL)')
            }
            catch (e) {
                console.log(e)
            }
            // db.close()
            let newDbPath = path.join(process.env.TMP ? process.env.TMP : process.env.TMPDIR, uuidV4() + ".sqlite");
            // tempDatabases.push(newDbPath);
            //Assuming the sqlite file is locked so lets make a copy of it
            fs.copyFileSync(paths[i], newDbPath);
            console.log(newDbPath);
            let sql = `SELECT title, last_visit_date last_visit_time, url from moz_places WHERE DATETIME (last_visit_date/1000000, 'unixepoch')  >= DATETIME('now', '- + ${historyTimeLength} minutes')`;
            browserHistory.push(await getHistoryFromDb(paths[i], newDbPath, sql, browserName));
        }
    }
    deleteTempFiles(newDbPaths);
    return browserHistory;

}

function getMaxthonBasedBrowserRecords(paths, browserName, historyTimeLength) {
    let browserHistory = [],
        h = [];
    return new Promise((resolve, reject) => {
        if (!paths || paths.length === 0) {
            resolve(browserHistory);
        }
        for (let i = 0; i < paths.length; i++) {
            if (paths[i] || paths[i] !== "") {

                let newDbPath = path.join(process.env.TMP ? process.env.TMP : process.env.TMPDIR, uuidV4() + ".db");

                //Assuming the sqlite file is locked so lets make a copy of it
                const originalDB = new Database(paths[i]);
                originalDB.serialize(() => {
                    // This has to be called to merge .db-wall, the in memory db, to disk so we can access the history when
                    // safari is open
                    originalDB.run("PRAGMA wal_checkpoint(FULL)");
                    originalDB.close(() => {
                        let readStream = fs.createReadStream(paths[i]),
                            writeStream = fs.createWriteStream(newDbPath),
                            stream = readStream.pipe(writeStream);

                        stream.on("finish", function() {
                            const db = new Database(newDbPath);
                            db.serialize(() => {
                                db.run("PRAGMA wal_checkpoint(FULL)");
                                db.each(
                                    "SELECT `zlastvisittime`, `zhost`, `ztitle`, `zurl` FROM   zmxhistoryentry WHERE  Datetime (`zlastvisittime` + 978307200, 'unixepoch') >= Datetime('now', '-" +
                                    historyTimeLength + " minutes')",
                                    function(err, row) {
                                        if (err) {
                                            reject(err);
                                        } else {
                                            let t = moment.unix(Math.floor(row.ZLASTVISITTIME + 978307200));
                                            browserHistory.push(
                                                {
                                                    title: row.ZTITLE,
                                                    utc_time: t.valueOf(),
                                                    url: row.ZURL,
                                                    browser: browserName,
                                                });
                                        }
                                    });

                                db.close(() => {
                                    fs.unlink(newDbPath, (err) => {
                                        if (err) {
                                            return reject(err);
                                        }
                                    });
                                    resolve(browserHistory);
                                });
                            });
                        });
                    });

                });
            }
        }
    });
}

function getSafariBasedBrowserRecords(paths, browserName, historyTimeLength) {
    let browserHistory = [],
        h = [];
    return new Promise((resolve, reject) => {
        if (!paths || paths.length === 0) {
            resolve(browserHistory);
        }
        for (let i = 0; i < paths.length; i++) {
            if (paths[i] || paths[i] !== "") {

                let newDbPath = path.join(process.env.TMP ? process.env.TMP : process.env.TMPDIR, uuidV4() + ".db");

                //Assuming the sqlite file is locked so lets make a copy of it
                const originalDB = new Database(paths[i]);
                originalDB.serialize(() => {
                    // This has to be called to merge .db-wall, the in memory db, to disk so we can access the history when
                    // safari is open
                    originalDB.run("PRAGMA wal_checkpoint(FULL)");
                    originalDB.close(() => {
                        let readStream = fs.createReadStream(paths[i]),
                            writeStream = fs.createWriteStream(newDbPath),
                            stream = readStream.pipe(writeStream);

                        stream.on("finish", function() {
                            const db = new Database(newDbPath);
                            db.serialize(() => {
                                db.run("PRAGMA wal_checkpoint(FULL)");
                                db.each(
                                    "SELECT i.id, i.url, v.title, v.visit_time FROM history_items i INNER JOIN history_visits v on i.id = v.history_item WHERE DATETIME (v.visit_time + 978307200, 'unixepoch')  >= DATETIME('now', '-" +
                                    historyTimeLength + " minutes')",
                                    function(err, row) {
                                        if (err) {
                                            reject(err);
                                        } else {
                                            let t = moment.unix(Math.floor(row.visit_time + 978307200));
                                            browserHistory.push(
                                                {
                                                    title: row.title,
                                                    utc_time: t.valueOf(),
                                                    url: row.url,
                                                    browser: browserName,
                                                });
                                        }
                                    });

                                db.close(() => {
                                    fs.unlink(newDbPath, (err) => {
                                        if (err) {
                                            return reject(err);
                                        }
                                    });
                                    resolve(browserHistory);
                                });
                            });
                        });
                    });

                });
            }
        }
    });
}

function getMicrosoftEdgePath(microsoftEdgePath) {
    return new Promise(function(resolve, reject) {
        fs.readdir(microsoftEdgePath, function(err, files) {
            if (err) {
                resolve(null);
                return;
            }
            for (let i = 0; i < files.length; i++) {
                if (files[i].indexOf("Microsoft.MicrosoftEdge") !== -1) {
                    microsoftEdgePath = path.join(
                        microsoftEdgePath, files[i], "AC", "MicrosoftEdge", "User", "Default", "DataStore", "Data",
                        "nouser1");
                    break;
                }
            }
            fs.readdir(microsoftEdgePath, function(err2, files2) {
                if (err) {
                    resolve(null);
                }
                //console.log(path.join(microsoftEdgePath, files2[0], "DBStore", "spartan.edb"));
                resolve(path.join(microsoftEdgePath, files2[0], "DBStore", "spartan.edb"));
            });
        });
    });
}

/**
 * Gets Firefox history
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getFirefoxHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.firefox = browsers.findPaths(browsers.defaultPaths.firefox, browsers.FIREFOX);
    return getBrowserHistory(browsers.browserDbLocations.firefox, browsers.FIREFOX, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Gets Seamonkey History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
function getSeaMonkeyHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.seamonkey, browsers.SEAMONKEY).then(foundPaths => {
            browsers.browserDbLocations.seamonkey = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.seamonkey, browsers.SEAMONKEY, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}

/**
 * Gets Chrome History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getChromeHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.chrome, browsers.CHROME).then(foundPaths => {
            browsers.browserDbLocations.chrome = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.chrome, browsers.CHROME, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}

/**
 * Get Opera History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getOperaHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.opera, browsers.OPERA).then(foundPaths => {
            browsers.browserDbLocations.opera = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.opera, browsers.OPERA, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}

/**
 * Get Torch History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getTorchHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.torch, browsers.TORCH).then(foundPaths => {
            browsers.browserDbLocations.torch = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.torch, browsers.TORCH, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}

/**
 * Get Brave History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getBraveHistory(historyTimeLength = 5) {
    browsers.browserDbLocations.brave = browsers.findPaths(browsers.defaultPaths.brave, browsers.BRAVE);
    return getBrowserHistory(browsers.browserDbLocations.brave, browsers.BRAVE, historyTimeLength).then(records => {
        return records;
    });
}

/**
 * Get Safari History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getSafariHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.safari, browsers.SAFARI).then(foundPaths => {
            browsers.browserDbLocations.safari = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.safari, browsers.SAFARI, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}

/**
 * Get Maxthon History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getMaxthonHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.maxthon, browsers.MAXTHON).then(foundPaths => {
            browsers.browserDbLocations.maxthon = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.maxthon, browsers.MAXTHON, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}

/**
 * Get Vivaldi History
 * @param historyTimeLength time is in minutes
 * @returns {Promise<array>}
 */
async function getVivaldiHistory(historyTimeLength = 5) {
    let getPaths = [
        browsers.findPaths(browsers.defaultPaths.vivaldi, browsers.VIVALDI).then(foundPaths => {
            browsers.browserDbLocations.vivaldi = foundPaths;
        }),
    ];
    Promise.all(getPaths).then(() => {
        let getRecords = [
            getBrowserHistory(browsers.browserDbLocations.vivaldi, browsers.VIVALDI, historyTimeLength),
        ];
        Promise.all(getRecords).then((records) => {
            return records;
        }, error => {
            throw error;
        });
    }, error => {
        throw error;
    });
}


/**
 * Gets the history for the Specified browsers and time in minutes.
 * Returns an array of browser records.
 * @param historyTimeLength | Integer
 * @returns {Promise<array>}
 */
async function getAllHistory(historyTimeLength = 5) {
    let allBrowserRecords = [];

    browsers.browserDbLocations.firefox = browsers.findPaths(browsers.defaultPaths.firefox, browsers.FIREFOX);
    browsers.browserDbLocations.chrome = browsers.findPaths(browsers.defaultPaths.chrome, browsers.CHROME);
    browsers.browserDbLocations.seamonkey = browsers.findPaths(browsers.defaultPaths.seamonkey, browsers.SEAMONKEY);
    browsers.browserDbLocations.opera = browsers.findPaths(browsers.defaultPaths.opera, browsers.OPERA);
    browsers.browserDbLocations.torch = browsers.findPaths(browsers.defaultPaths.torch, browsers.TORCH);
    browsers.browserDbLocations.brave = browsers.findPaths(browsers.defaultPaths.brave, browsers.BRAVE);
    browsers.browserDbLocations.safari = browsers.findPaths(browsers.defaultPaths.safari, browsers.SAFARI);
    browsers.browserDbLocations.seamonkey = browsers.findPaths(browsers.defaultPaths.seamonkey, browsers.SEAMONKEY);
    browsers.browserDbLocations.maxthon = browsers.findPaths(browsers.defaultPaths.maxthon, browsers.MAXTHON);
    browsers.browserDbLocations.vivaldi = browsers.findPaths(browsers.defaultPaths.vivaldi, browsers.VIVALDI);

    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.firefox, browsers.FIREFOX, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.seamonkey, browsers.SEAMONKEY, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.chrome, browsers.CHROME, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.opera, browsers.OPERA, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.torch, browsers.TORCH, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.brave, browsers.BRAVE, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.safari, browsers.SAFARI, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.vivaldi, browsers.VIVALDI, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.seamonkey, browsers.SEAMONKEY, historyTimeLength));
    allBrowserRecords = allBrowserRecords.concat(await getBrowserHistory(browsers.browserDbLocations.maxthon, browsers.MAXTHON, historyTimeLength));
    //No Path because this is handled by the dll

    return allBrowserRecords;
}

module.exports = {
    getAllHistory,
    getFirefoxHistory,
    getSeaMonkeyHistory,
    getChromeHistory,
    getOperaHistory,
    getTorchHistory,
    getBraveHistory,
    getSafariHistory,
    getMaxthonHistory,
    getVivaldiHistory
};

