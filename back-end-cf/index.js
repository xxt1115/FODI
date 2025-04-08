const EXPOSE_PATH = "home1test";
const ONEDRIVE_REFRESHTOKEN = "M.C548_BAY.0.U.-ChKLMJCqEiEY68OiVvEAbkVZfaZVIN7WfkmQplxF790C35wt!!4tFHuW6vI9kdW8VAfGdV!GR6RmQjVQJxzB*1W8kjIvIbuOBPKZB0wbxEK49wlirMnn7P4wB1VXijEJZn1qe7cCKSXKa*v3N9XgmwMAdLQ4giALA6wxa3l9YZu5O5mgksZIHiYu296eRXjy5Q6KwX6tlkaHp*yBN4sGG3*i9dIXiMyjeL9X1z!kVdfDiC2d9EtDEP1R7*dlyrL91TTr3VtJy7UensHfJxygWdxUbCOz!mAjVyZkZBjwiOytIiHciWgJ4fEY5Qm36BRzK5bOHWMV0wCNsKuRZOYmKgvyNMcPiCtCYq6kjhAPG9pNm6FhhDJy0Ud1wKKY3*UyBj9Ttz!jDes2pZmRvtplDbM$";
const PASSWD_FILENAME = ".password";
const PROTECTED_LAYERS = -1;
const clientId = "78d4dc35-7e46-42c6-9023-2d39314433a5";
const clientSecret = "ZudGl-p.m=LMmr3VrKgAyOf-WevB3p50";
const loginHost = "https://login.microsoftonline.com";
const apiHost = "https://graph.microsoft.com";
const redirectUri = "http://localhost/onedrive-login"

addEventListener('scheduled', (event) => {
  event.waitUntil(fetchAccessToken());
});

addEventListener('fetch', (event) => {
  event.respondWith(
    handleRequest(event.request).catch((e) =>
      Response.json({ error: e.message })
    )
  );
});

const OAUTH = {
  redirectUri: redirectUri,
  refreshToken: ONEDRIVE_REFRESHTOKEN,
  clientId: clientId,
  clientSecret: clientSecret,
  oauthUrl: loginHost + '/common/oauth2/v2.0/',
  apiUrl: apiHost + '/v1.0/me/drive/root',
  scope: apiHost + '/Files.ReadWrite.All offline_access',
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
}

async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const file = requestUrl.searchParams.get('file') || decodeURIComponent(requestUrl.pathname);
  const davMethods = ['COPY', 'DELETE', 'HEAD', 'MKCOL', 'MOVE', 'PROPFIND', 'PROPPATCH', 'PUT'];

  const handlers = {
    // Preflight
    OPTIONS: () => {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'DAV': '1, 3',
        },
      });
    },
    // Download a file
    GET: () => {
      const fileName = file.split('/').pop();
      if (!fileName) return new Response('Bad Request', { status: 400 });
      if (fileName.toLowerCase() === PASSWD_FILENAME.toLowerCase()) {
        return new Response('Access Denied', { status: 403 });
      }
      return downloadFile(file, requestUrl.searchParams.get('format'));
    },
    // Upload and List files
    POST: () => handlePostRequest(request, requestUrl),
  };

  const handler = handlers[request.method] ||
    ( davMethods.includes(request.method)
     ? () => handleWebdav(file, request, env.WEBDAV)
     : () => new Response('Method Not Allowed', { status: 405 }) );

  return handler();
}

async function gatherResponse(response) {
  const { headers } = response;
  const contentType = headers.get('content-type');
  if (contentType.includes('application/json')) {
    return await response.json();
  }
  return await response.text();
}

async function cacheFetch(url, options) {
  return fetch(new Request(url, options), {
    cf: {
      cacheTtl: 3600,
      cacheEverything: true,
    },
  });
}

async function fetchWithAuth(uri, options = {}) {
  const accessToken = await fetchAccessToken();
  return cacheFetch(uri, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
}

async function getContent(url, headers) {
  const response = await cacheFetch(url, { headers });
  const result = await gatherResponse(response);
  return result;
}

async function postFormData(url, data) {
  const formData = new FormData();
  for (const key in data) {
    formData.append(key, data[key]);
  }
  const requestOptions = {
    method: 'POST',
    body: formData,
  };
  const response = await cacheFetch(url, requestOptions);
  const result = await gatherResponse(response);
  return result;
}

async function fetchAccessToken() {
  let refreshToken = OAUTH['refreshToken'];
  if (typeof FODI_CACHE !== 'undefined') {
    const cache = JSON.parse(await FODI_CACHE.get('token_data'));
    if (cache?.refresh_token) {
      const passedMilis = Date.now() - cache.save_time;
      if (passedMilis / 1000 < cache.expires_in - 600) {
        return cache.access_token;
      }

      if (passedMilis < 6912000000) {
        refreshToken = cache.refresh_token;
      }
    }
  }

  const url = OAUTH['oauthUrl'] + 'token';
  const data = {
    client_id: OAUTH['clientId'],
    client_secret: OAUTH['clientSecret'],
    grant_type: 'refresh_token',
    requested_token_use: 'on_behalf_of',
    refresh_token: refreshToken,
  };
  const result = await postFormData(url, data);

  if (typeof FODI_CACHE !== 'undefined' && result?.refresh_token) {
    result.save_time = Date.now();
    await FODI_CACHE.put('token_data', JSON.stringify(result));
  }
  return result.access_token;
}

async function authenticate(path, passwd, davAuthHeader, WEBDAV) {
  if (davAuthHeader) {
    const encoder = new TextEncoder();
    const header = encoder.encode(davAuthHeader);
    const isValid = Object.entries(JSON.parse(WEBDAV)).some(([key, value]) => {
      const expected = encoder.encode(`Basic ${btoa(`${key}:${value}`)}`);
      return header.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(header, expected);
    });
    return isValid;
  }

  const pwFileContent = await downloadFile(
    `${path}/${PASSWD_FILENAME}`,
    null,
    true
  )
    .then((resp) => (resp.status === 401 ? cacheFetch(resp.url) : resp))
    .then((resp) => (resp.status === 404 ? undefined : resp.text()));

  if (pwFileContent) {
    return passwd === pwFileContent;
  } else if (path !== '/' && path.split('/').length <= PROTECTED_LAYERS) {
    return await authenticate('/', passwd);
  }
  return true;
}

async function handlePostRequest(request, requestUrl) {
  const returnHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'max-age=3600',
    'Content-Type': 'application/json; charset=utf-8',
  };
  const body = await request.json();
  const requestPath = decodeURIComponent(body.path || '');

  // Upload files
  if (requestUrl.searchParams.has('upload')) {
    const allowUpload =
      (await downloadFile(`${requestPath}/.upload`)).status === 302;

    const uploadAuth = await authenticate(requestPath, body.passwd);

    if (
      !allowUpload || !uploadAuth ||
      body.files.some(
        (file) =>
          file.remotePath.split('/').pop().toLowerCase() ===
          PASSWD_FILENAME.toLowerCase()
      )
    ) {
      throw new Error('access denied');
    }

    const uploadLinks = JSON.stringify(await uploadFiles(body.files));
    return new Response(uploadLinks, {
      headers: returnHeaders,
    });
  }

  // List a folder
  const listAuth = await authenticate(requestPath, body.passwd);
  const files = listAuth ? JSON.stringify(await fetchFiles(
    requestPath,
    body.skipToken,
    body.orderby
  )) : JSON.stringify({
    parent: requestPath,
    files: [],
    encrypted: true,
  });
  return new Response(files, {
    headers: returnHeaders,
  });
}

async function fetchFiles(path, skipToken, orderby) {
  const parent = path || '/';

  if (path === '/') path = '';
  if (path || EXPOSE_PATH) {
    // if EXPOSE_PATH + path equals to an empty string, ':' will lead to an error.
    path = ':' + encodeURIComponent(EXPOSE_PATH + path) + ':';
  }
  const accessToken = await fetchAccessToken();
  const expand = [
    '/children?select=name,size,parentReference,lastModifiedDateTime,@microsoft.graph.downloadUrl',
    orderby ? `&orderby=${encodeURIComponent(orderby)}` : '',
    skipToken ? `&skiptoken=${skipToken}` : '',
  ].join('');
  const uri = OAUTH.apiUrl + path + expand;

  const pageRes = await getContent(uri, {
    Authorization: 'Bearer ' + accessToken,
  });
  if (pageRes.error) {
    return { error: 'request failed' };
  }

  skipToken = pageRes['@odata.nextLink']
    ? new URL(pageRes['@odata.nextLink']).searchParams.get('$skiptoken')
    : undefined;
  const children = pageRes.value;

  return {
    parent,
    skipToken,
    orderby,
    files: children
      .map((file) => ({
        name: file.name,
        size: file.size,
        lastModifiedDateTime: file.lastModifiedDateTime,
        url: file['@microsoft.graph.downloadUrl'],
      }))
      .filter((file) => file.name !== PASSWD_FILENAME),
  };
}

async function downloadFile(filePath, format, stream) {
  const supportedFormats = ['glb', 'html', 'jpg', 'pdf'];
  if (format && !supportedFormats.includes(format.toLowerCase())) {
    throw new Error('unsupported target format');
  }

  filePath = encodeURIComponent(`${EXPOSE_PATH}${filePath}`);
  const uri =
    `${OAUTH.apiUrl}:${filePath}:/content` +
    (format ? `?format=${format}` : '') +
    (format === 'jpg' ? '&width=30000&height=30000' : '');

  return fetchWithAuth(uri, {
    redirect: stream ? 'follow' : 'manual',
  });
}

async function uploadFiles(fileList) {
  const batchRequest = {
    requests: fileList.map((file, index) => ({
      id: `${index + 1}`,
      method: file['fileSize'] ? 'POST' : 'PUT',
      url: `/me/drive/root:${encodeURI(EXPOSE_PATH + file['remotePath'])}${
        file['fileSize'] ? ':/createUploadSession' : ':/content'
      }`,
      headers: { 'Content-Type': 'application/json' },
      body: {},
    })),
  };
  const batchResponse = await fetchWithAuth(`${apiHost}/v1.0/$batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchRequest),
  });
  const batchResult = await batchResponse.json();
  batchResult.responses.forEach((response) => {
    if (response.status === 200) {
      const index = parseInt(response.id) - 1;
      fileList[index].uploadUrl = response.body.uploadUrl;
    }
  });
  return { files: fileList };
}

async function handleWebdav(filePath, request, WEBDAV) {
  const davAuth = await authenticate(null, null, request.headers.get('Authorization'), WEBDAV);
  if (!davAuth) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="WebDAV"',
      },
    });
  }

  const handlers = {
    COPY: () => handleCopyMove(filePath, 'COPY', request.headers.get('Destination')),
    MOVE: () => handleCopyMove(filePath, 'MOVE', request.headers.get('Destination')),
    DELETE: () => handleDelete(filePath),
    HEAD: () => handleHead(filePath),
    MKCOL: () => handleMkcol(filePath),
    PUT: () => handlePut(filePath, request),
    PROPFIND: () => handlePropfind(filePath),
  };
  const handler = handlers[request.method] || (() => ({ davXml: null, davStatus: 405 }));
  const davRes = await handler();

  return new Response(davRes.davXml, {
    status: davRes.davStatus,
    headers: davRes.davXml
      ? { 'Content-Type': 'application/xml; charset=utf-8' }
      : {}
  });
}

function davPathSplit(filePath) {
  filePath = filePath.includes('://') 
    ? decodeURIComponent(new URL(filePath).pathname)
    : filePath;
  if (!filePath) filePath = '/';
  const isDirectory = filePath.endsWith('/');
  const nomalizePath = isDirectory ? filePath.slice(0, -1) : filePath;
  return {
    parent: nomalizePath.split('/').slice(0, -1).join('/') || '/',
    tail: nomalizePath.split('/').pop(),
    isDirectory: isDirectory,
    path: nomalizePath || '/'
  };
}

function createReturnXml(uriPath, davStatus, statusText){
  return`<?xml version="1.0" encoding="utf-8"?>
  <d:multistatus xmlns:d="DAV:">
    <d:response>
      <d:href>${uriPath.split('/').map(encodeURIComponent).join('/')}</d:href>
      <d:status>HTTP/1.1 ${davStatus} ${statusText}</d:status>
    </d:response>
  </d:multistatus>`;
}

function createPropfindXml(parent, files, isDirectory) {
  if (parent === '/') parent = '';
  const encodedParent = parent.split('/').map(encodeURIComponent).join('/');
  const xmlParts = [
    '<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">\n'
  ];

  if (isDirectory) {
    const directory = {
      name: '',
      size: 0,
      lastModifiedDateTime: 0
    };
    xmlParts.push(createResourceXml(encodedParent, directory, true));
  }

  if (files) {
    for (const file of files) {
      xmlParts.push(createResourceXml(encodedParent, file, !file.url));
    }
  }

  xmlParts.push('</d:multistatus>');
  return xmlParts.join('');
}

function createResourceXml(encodedParent, resource, isDirectory) {
  const encodedName = resource.name ? `/${encodeURIComponent(resource.name)}` : '';
  const modifiedDate = new Date(resource.lastModifiedDateTime).toUTCString();
  return `\n<d:response>
    <d:href>${encodedParent}${encodedName}${isDirectory ? '/' : ''}</d:href>
    <d:propstat>
      <d:prop>
        ${isDirectory ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>'}
        <d:getcontenttype>${isDirectory ? 'httpd/unix-directory' : 'application/octet-stream'}</d:getcontenttype>
        <d:getcontentlength>${resource.size}</d:getcontentlength>
        <d:getlastmodified>${modifiedDate}</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>\n`;
}

async function handleCopyMove(filePath, method, destination){
  const { parent: parent, path: uriPath } = davPathSplit(filePath);
  const uri = `${OAUTH.apiUrl}:${encodeURIComponent(EXPOSE_PATH + uriPath)}` + (method === 'COPY' ? ':/copy' : '');
  const { parent: newParent, tail: newTail } = davPathSplit(destination);

  const res = await fetchWithAuth(uri, {
    method: method === 'COPY' ? 'POST' : 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      newParent === parent
        ? { name: newTail }
        : { parentReference: { path: `/drive/root:${EXPOSE_PATH}${newParent}` } }
    )
  });

  const davStatus = res.status === 200 ? 201 : res.status;
  const responseXML = davStatus === 201
    ? null
    : createReturnXml(uriPath, davStatus, res.statusText);

  return { davXml: responseXML, davStatus: davStatus };
}

async function handleDelete(filePath){
  const uriPath = davPathSplit(filePath).path;
  const uri = `${OAUTH.apiUrl}:${encodeURIComponent(EXPOSE_PATH + uriPath)}`;

  const res = await fetchWithAuth(uri, { method: 'DELETE' });
  const davStatus = res.status;
  const responseXML = davStatus === 204
    ? null
    : createReturnXml(uriPath, davStatus, res.statusText);

  return { davXml: responseXML, davStatus: davStatus };
}

async function handleHead(filePath) {
  const uri = [
    OAUTH.apiUrl,
    `:${encodeURIComponent(EXPOSE_PATH + davPathSplit(filePath).path)}`,
    '?select=size,file,lastModifiedDateTime'
  ].join('');
  const res = await fetchWithAuth(uri);
  const data = await res.json();

  return new Response(null, {
    status: res.status,
    headers: res.ok ? {
      'Content-Length': data.size,
      'Content-Type': data?.file?.mimeType,
      'date': new Date(data.lastModifiedDateTime).toUTCString()
    } : {}
  });
}

async function handleMkcol(filePath){
  const { parent, tail } = davPathSplit(filePath);
  const uri = `${OAUTH.apiUrl}:${encodeURIComponent(EXPOSE_PATH + parent)}:/children`;

  const res = await fetchWithAuth(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: tail,
      folder: {},
      "@microsoft.graph.conflictBehavior": "replace"
    })
  });

  const davStatus = res.status === 200 ? 201 : res.status;
  const responseXML = davStatus === 201
    ? null
    : createReturnXml(parent, davStatus, res.statusText);

  return { davXml: responseXML, davStatus: davStatus };
}

async function handlePropfind(filePath) {
  const { parent, tail, isDirectory, path } = davPathSplit(filePath);
  const fetchPath = isDirectory ? path : parent;
  let hasMorePages = true, nextPageToken = null, allFiles = [];

  while (hasMorePages) {
    const fetchData = await fetchFiles(fetchPath, nextPageToken, null);
    if (!fetchData || fetchData.error) {
      return { davXml: null, davStatus: 404 };
    }
    allFiles.push(...fetchData.files);
    nextPageToken = fetchData.skipToken;
    hasMorePages = !!nextPageToken;
  }

  const targetFile = isDirectory ? null : allFiles.find(file => file.name === tail);
  if (!isDirectory && !targetFile) {
    return { davXml: null, davStatus: 404 };
  }

  const sourceFiles = isDirectory ? allFiles : [targetFile];
  const responseXML = createPropfindXml(fetchPath, sourceFiles, isDirectory);

  return { davXml: responseXML, davStatus: 207 };
}

async function handlePut(filePath, request) {
  const fileLength = parseInt(request.headers.get('Content-Length'));
  const body = await request.arrayBuffer();
  const uploadList = [{
    remotePath: filePath,
    fileSize: fileLength,
  }];
  const uploadUrl = (await uploadFiles(uploadList)).files[0].uploadUrl;

  const chunkSize = 1024 * 1024 * 60;
  let start = 0, newStart, retryCount = 0;
  const maxRetries = 3;
  const initialDelay = 2000;

  while (start < fileLength) {
    const end = Math.min(start + chunkSize, fileLength);
    const chunk = body.slice(start, end);

    const res = await fetch(uploadUrl, {
      method: 'PUT',
      body: chunk,
      headers: {
        'Content-Range': `bytes ${start}-${end - 1}/${fileLength}`,
      },
    });

    if (res.status >= 400) {
      const data = await cacheFetch(uploadUrl);
      const jsonData = await data.json();
      newStart = parseInt(jsonData.nextExpectedRanges[0].split('-')[0]);

      if (!newStart) {
        return {
          davXml: createReturnXml(filePath, res.status, res.statusText),
          davStatus: res.status,
        };
      }

      if (retryCount < maxRetries) {
        const delay = initialDelay * Math.pow(2, retryCount);
        await new Promise((resolve) => setTimeout(resolve, delay));
        retryCount++;
        continue;
      } else {
        return {
          davXml: createReturnXml(filePath, res.status, 'Max retries exceeded'),
          davStatus: res.status,
        };
      }
    }

    retryCount = 0;
    start = newStart || end;
    newStart = undefined;
  }

  return { davXml: null, davStatus: 201 };
}
