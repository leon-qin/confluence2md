const https = require('https');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const turndownService = new TurndownService();
const turndownPluginGfm = require('turndown-plugin-gfm');

// Import plugins from turndown-plugin-gfm
const gfm = turndownPluginGfm.gfm;
const tables = turndownPluginGfm.tables;
const strikethrough = turndownPluginGfm.strikethrough;

// Use the gfm plugin
turndownService.use(gfm)

// Use the table and strikethrough plugins only
turndownService.use([tables, strikethrough])

const outputFolder = 'output';
const pages = [{ id: '43387057', localFolder: outputFolder }];

const siteProtocol = 'https:';
const siteHost = 'confluence-ext.perkinelmer.com';
const siteUsername = 'qinll';
const sitePassword = 'Aa@201806';

function getHttpRequestOptions(url, contentType) {
    const options = {
        protocol: siteProtocol,
        host: siteHost,
        path: url,
        auth: `${siteUsername}:${sitePassword}`,
        headers: {
            'X-Atlassian-Token': 'no-check',
        }
    };

    if (contentType) {
        options.headers['Content-Type'] = contentType;
        options.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8';
    }

    return options;
}

function handleResponseError(res, reject) {
    const { statusCode } = res;

    let error;
    if (statusCode !== 200) {
        error = new Error('Request Failed.\n' +
            `Status Code: ${statusCode}`);
    }

    if (error) {
        console.error(error.message);
        // consume response data to free up memory
        res.resume();
        reject(error.message);
    }
}

function updatePageInfo(page, result) {
    page.pageUrl = result._links.webui;
    page.id = result.id;
    page.url = result.self;
    if (result.title) {
        page.title = result.title;
        page.safeName = generateValidPathFromName(page.title);
        page.localHtmlPath = path.join(page.localFolder, page.safeName + '.html');
    }
}

function getExtNameByMediaType(mediaType) {
    if (mediaType === 'image/png') {
        return 'png'
    } else if (mediaType === 'image/svg+xml') {
        return 'svg'
    } else if (mediaType === 'image/gif') {
        return 'gif'
    } else if (mediaType === 'image/jpeg') {
        return 'jpg'
    } else {
        return ''
    }
}

function updateAttachmentInfo(attachment, result) {
    attachment.title = result.title;
    attachment.safeName = generateValidPathFromName(attachment.title);
    attachment.mediaType = result.metadata.mediaType;
    attachment.downloadUrl = result._links.download;
    attachment.localPath = path.join(attachment.localFolder, attachment.safeName + '.' + getExtNameByMediaType(attachment.mediaType));
}

/**
 * https://confluence-ext.perkinelmer.com/rest/api/content?title=ChemDraw%20Development%20Guide&spaceKey=PMO
 * @param {} id 
 */
function analyzePageContent(page) {
    const url = `/rest/api/content/${page.id}`;
    //console.info(`Analyzing ${url} ${JSON.stringify(page)}`);
    //https://confluence-ext.perkinelmer.com/rest/api/content/43387057

    //https://confluence-ext.perkinelmer.com/rest/api/content/43387057/child/attachment
    return new Promise((resolve, reject) => {
        https.get(getHttpRequestOptions(url, 'application/json'), (res) => {
            handleResponseError(res, reject);

            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    updatePageInfo(page, JSON.parse(rawData));
                    resolve(page);
                } catch (e) {
                    reject(e.message);
                }
            });
        }).on('error', (e) => {
            reject(e.message);
        });
    });
}

function analyzePageChildPages(page) {
    const url = `/rest/api/content/${page.id}/child/page`;
    //console.info(`Analyzing child pages ${url}`);
    //https://confluence-ext.perkinelmer.com/rest/api/content/43387057/child/page
    return new Promise((resolve, reject) => {
        https.get(getHttpRequestOptions(url, 'application/json'), (res) => {
            handleResponseError(res, reject);

            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(rawData);
                    if (result.results && result.results.length > 0) {
                        page.childPages = [];
                        for (let i = 0; i < result.results.length; i++) {
                            const childPage = { localFolder: path.join(page.localFolder, page.safeName) };
                            updatePageInfo(childPage, result.results[i]);
                            page.childPages.push(childPage);
                            pages.push(childPage);
                        }
                    }
                    resolve(page);
                } catch (e) {
                    reject(e.message);
                }
            });
        }).on('error', (e) => {
            reject(e.message);
        });
    });
}

function analyzePageAttachments(page) {
    const url = `/rest/api/content/${page.id}/child/attachment`;
    //console.info(`Analyzing attachments ${url}`);

    //https://confluence-ext.perkinelmer.com/rest/api/content/43387057/child/attachment
    return new Promise((resolve, reject) => {
        https.get(getHttpRequestOptions(url, 'application/json'), (res) => {
            handleResponseError(res, reject);

            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(rawData);
                    if (result.results && result.results.length > 0) {
                        page.attachments = [];
                        for (let i = 0; i < result.results.length; i++) {
                            let attachment = { localFolder: path.join(page.localFolder, 'attachments') };
                            updateAttachmentInfo(attachment, result.results[i]);
                            if (attachment.mediaType.startsWith('image')) {
                                page.attachments.push(attachment);
                            }
                        }
                    }
                    resolve(page);
                } catch (e) {
                    reject(e.message);
                }
            });
        }).on('error', (e) => {
            reject(e.message);
        });
    });
}

function downloadAttachments(page) {
    return new Promise((resolve, reject) => {
        if (!page.attachments) {
            resolve(page);
        } else {
            const attachmentsToDownload = [];
            page.attachments.forEach(attachment => {
                ensureFolderExist(attachment.localFolder);
                attachmentsToDownload.push(downloadImage(attachment.downloadUrl, attachment.localPath));
            });
            Promise.all(attachmentsToDownload).then(resolve(page)).catch(reject);
        }
    });
}

function downloadImage(url, dest) {
    //console.info('Downloading attachment ' + url)
    return new Promise((resolve, reject) => {
        const imageNames = getImageName(url);
        if (imageNames.length != 1) {
            return;
        }

        var file = fs.createWriteStream(dest);

        var request = https.get(getHttpRequestOptions(url), (res) => {
            handleResponseError(res, reject);
            res.pipe(file);
            file.on('finish', function () {
                file.close(() => {
                    resolve();
                });
            });
        });
    });
}

function downloadPage(page) {
    const url = page.pageUrl;
    const dest = page.localHtmlPath;
    ensureFolderExist(page.localFolder);
    //console.info(`Downloading ${url} to ${dest}`)
    return new Promise((resolve, reject) => {
        https.get(getHttpRequestOptions(url), (res) => {
            handleResponseError(res, reject);

            res.setEncoding('utf8');
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    fs.writeFileSync(dest, rawData);
                    resolve(page);
                } catch (e) {
                    reject(e.message);
                }
            });
        }).on('error', (e) => {
            reject(e.message);
        });
    });
}

function fixLinks($, element, page) {
    const depPages = [];

    element.find('a').each((i, elem) => {
        const depsUrl = $(elem).attr('href');
        let fixedUrl = depsUrl;

        let isAChildPage = false;
        if (page.childPages) {
            page.childPages.forEach(childPage => {
                if (childPage.pageUrl === fixedUrl) {
                    fixedUrl = `${page.safeName}/${childPage.safeName}.md`;
                    isAChildPage = true;
                }
            });
        }

        if (!isAChildPage && fixedUrl && fixedUrl.startsWith('/'))  {
            fixedUrl = `${siteProtocol}//${siteHost}${fixedUrl}`;
        }
        console.info(fixedUrl);

        if (fixedUrl !== depsUrl) {
            $(elem).attr('href', fixedUrl);
        }
    });

    return depPages;
}

function fixImages($, element, page) {
    element.find('img').each((i, elem) => {
        const depsUrl = $(elem).attr('src');
        let fixedUrl = depsUrl;
        if (fixedUrl && fixedUrl.startsWith('/download')) {
            if (page.attachments) {
                page.attachments.forEach(attachment => {
                    if (attachment.downloadUrl === fixedUrl) {
                        fixedUrl = `attachments/${path.basename(attachment.localPath)}`;
                    }
                });
            }
        } else if (fixedUrl && fixedUrl.startsWith('/')) {
            fixedUrl = `${siteProtocol}//${siteHost}${fixedUrl}`;
        } else {
            // Refer to image using abslute URL.
        }

        if (fixedUrl !== depsUrl) {
            $(elem).attr('src', fixedUrl);
        }
    });
}

function savePageAsMarkdown(page) {
    return new Promise((resolve, reject) => {
        try {
            const content = fs.readFileSync(page.localHtmlPath, 'utf8');
            const $ = cheerio.load(content);
            const title = $('#title-text>a').html();
            const author = $('#content>.page-metadata>ul>li>.author>a').html();
            const lastModifiedBy = $('#content>.page-metadata>ul>li>.editor>a').html();
            // Don't include grand-children pages.
            $('#main-content>.childpages-macro>li>ul').remove();
            const mainContent = $('#main-content');
            fixLinks($, mainContent, page);
            fixImages($, mainContent, page);

            const mainContentHtml = mainContent.html();

            let markdown = turndownService.turndown(mainContentHtml);
            markdown = `${generateFrontMatter(title, author)}\r\n\r\n# ${title}\r\n\r\n${markdown}`;
            let mdPath = path.join(page.localFolder, page.safeName + '.md');
            fs.writeFileSync(mdPath, markdown);
            page.localMdPath = mdPath;

            resolve(page);
        } catch (e) {
            reject(e.message);
        }
    });
}

function removeLocalHtmlPage(page) {
    fs.unlinkSync(page.localHtmlPath);
    delete page.localHtmlPath;
}

function generateValidPathFromName(name) {
    return name.trim().replace(/['|&:;$%@"?<>()+,=\s\./]+/g, '_').toLowerCase();
}

function generateFrontMatter(title, author) {
    let metadata = '---\r\n';
    metadata += `title: ${title}\r\n`;
    metadata += `author: ${author}\r\n`;
    metadata += '---';

    return metadata;
}

function getImageName(url) {
    return url.match(/[\w-]+\.(jpg|png|svg)/g);
}

function ensureFolderExist(folder) {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder);
    }
}

function analysizePage(page) {
    return analyzePageContent(page)
        .then(analyzePageChildPages)
        .then(analyzePageAttachments)
        .catch(e => {
            console.error(e);
        });
}

let downloadPromises = [];
async function retrievePagesRecursively() {
    for (let i = 0; i < pages.length; i++) {
        console.info(`${i} / ${pages.length}`);
        await analysizePage(pages[i]);
    }

    fs.writeFileSync('pages.json', JSON.stringify(pages));

    for (let i = 0; i < pages.length; i++) {
        let download = downloadPage(pages[i])
            .then(downloadAttachments)
            .then(savePageAsMarkdown);
            //.then(removeLocalHtmlPage);
        downloadPromises.push(download);
    }
}

ensureFolderExist(outputFolder);
retrievePagesRecursively();
Promise.all(downloadPromises).then(()=>{
    console.info('Done');
})