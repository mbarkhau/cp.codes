#!/usr/bin/env python3
"""Generate/update a local secret file without exposing passwords in arguments."""
import argparse
import getpass
import hashlib
import json
import os
import re
import secrets
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('username')
    parser.add_argument('--role', choices=('admin', 'mod'), default='admin')
    parser.add_argument('--output', type=Path, default=Path('.staff-credentials.json'))
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', args.username):
        parser.error('Use a simple alphanumeric username')
    password = getpass.getpass('Password (at least 12 characters): ')
    if len(password) < 12 or len(password) > 256:
        parser.error('Password must be 12–256 characters')
    if getpass.getpass('Confirm password: ') != password:
        parser.error('Passwords do not match')
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000).hex()
    users = json.loads(args.output.read_text()) if args.output.exists() else []
    users = [user for user in users if user['username'] != args.username]
    users.append(dict(username=args.username, role=args.role, salt=salt.hex(), passwordHash=digest))
    if len(users) > 8:
        parser.error('At most 8 staff users are supported')
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(users, output, separators=(',', ':'))
    print(f'Wrote {args.output} (mode 0600). Install with: npx wrangler secret put STAFF_CREDENTIALS < {args.output}')


if __name__ == '__main__':
    main()
