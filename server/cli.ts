// Admin command-line tool. Sends one command to the running server over its local admin
// socket and prints the reply.  Usage: alliance <command> [args]   (alliance help)

import { connect } from 'node:net';
import { defaultAdminSocket } from './config.ts';

let argv = process.argv.slice(2);
let socketPath = defaultAdminSocket();
if (argv[0] === '--socket') {
  socketPath = argv[1] ?? socketPath;
  argv = argv.slice(2);
}
if (argv.length === 0) argv = ['help'];

const sock = connect(socketPath);
let reply = '';
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(JSON.stringify({ argv }) + '\n'));
sock.on('data', (chunk: string) => {
  reply += chunk;
});
sock.on('end', () => {
  try {
    const res = JSON.parse(reply) as { ok: boolean; output: string };
    if (res.ok) {
      console.log(res.output);
    } else {
      console.error(res.output);
      process.exitCode = 1;
    }
  } catch {
    console.error('Unexpected reply from server');
    process.exitCode = 1;
  }
});
sock.on('error', (err) => {
  console.error(`Can't reach the Alliance server at ${socketPath} (${err.message}). Is it running?`);
  process.exitCode = 2;
});
