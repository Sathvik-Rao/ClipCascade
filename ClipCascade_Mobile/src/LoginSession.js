// React Native's cookie jar handles both anonymous and rotated login cookies.
// A reused session does not have to produce another Set-Cookie response header.
export async function authenticateSession({
  fetchRequest,
  serverUrl,
  username,
  password,
  parseCsrfToken,
}) {
  const page = await fetchRequest(serverUrl + '/login', {
    method: 'GET',
    credentials: 'include',
  });
  if (!page.ok) {
    return { ok: false, message: `Failed to fetch login page: ${page.status}` };
  }

  const csrfToken = parseCsrfToken(await page.text());
  if (!csrfToken) {
    return {
      ok: false,
      message:
        'No CSRF token found. Check the server URL and proxy login page.',
    };
  }

  const form = new URLSearchParams();
  form.append('username', username);
  form.append('password', password);
  form.append('_csrf', csrfToken);
  const response = await fetchRequest(serverUrl + '/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await response.text();
  if (body.toLowerCase().includes('bad credentials')) {
    return { ok: false, message: 'Incorrect username or password.' };
  }
  if (!response.ok) {
    return {
      ok: false,
      message:
        response.status === 403
          ? 'Login rejected (403). Check session cookies and reverse-proxy HTTPS settings.'
          : `Login failed: ${response.status}`,
    };
  }

  // fetch follows redirects, so even a failed login can finish with HTTP 200.
  const session = await fetchRequest(serverUrl + '/validate-session', {
    method: 'GET',
    credentials: 'include',
  });
  if (!session.ok || (await session.text()) !== 'OK') {
    return {
      ok: false,
      message:
        'Login could not be verified. Check credentials, session cookies, and reverse-proxy settings.',
    };
  }
  return { ok: true, status: response.status };
}
