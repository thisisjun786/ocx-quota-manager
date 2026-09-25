#!/usr/bin/python3
"""Request Kimi quota through its credential owner; never handle provider tokens."""
import json
import os
import pathlib
import re
import urllib.request

HOME_DIR = pathlib.Path(os.environ.get('OPENCODEX_HOME') or pathlib.Path.home() / '.opencodex')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def main():
    config = json.loads((HOME_DIR / 'config.json').read_text())
    provider = config.get('providers', {}).get('kimi', {})
    if provider.get('disabled') or provider.get('authMode') != 'oauth':
        print('Kimi OAuth collection disabled')
        return
    if provider.get('baseUrl', '').rstrip('/') != 'https://api.kimi.com/coding/v1':
        raise RuntimeError('Kimi endpoint configuration changed')
    token = (HOME_DIR / 'admin-api-token').read_text().strip()
    if not re.fullmatch(r'ocx_admin_[A-Za-z0-9_-]{43}', token):
        raise RuntimeError('Management authentication unavailable')
    request = urllib.request.Request(
        'http://127.0.0.1:10104/api/oauth/accounts?provider=kimi&quota=1&refresh=1',
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=25) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise RuntimeError('Quota response too large')
    accounts = json.loads(raw).get('accounts')
    if not isinstance(accounts, list) or not accounts:
        raise RuntimeError('No Kimi account available')
    if any(a.get('needsReauth') or a.get('quotaUnavailable') or not a.get('quota') for a in accounts):
        raise RuntimeError('Kimi quota unavailable')
    print('Kimi quota collection completed')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Kimi quota collection failed; check OCX account status')
        raise SystemExit(1)
