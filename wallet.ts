// wallet.ts
import * as crypto from "crypto";
import * as fs from "fs";
import WebSocket from "ws";

export type WalletFileShape = {
  publicKey: string;
  privateKey: string;
  address?: string;
};

export type WalletTxLike = {
  toJSON(): any;
};

export type WalletTxCtor = new (args: {
  type: "TRANSFER" | "COINBASE";
  from: string | null;
  to: string;
  amount: number;
  fee: number;
  nonce?: number;
  ts?: number;
  signature?: string | null;
  id?: string;
}) => WalletTxLike & {
  id: string;
  sign(privateKeyPem: string): void;
};

export type SubmitEnvelopeArgs = {
  networkMagic: number;
  chainId: string;
  protocolVersion: number;
};

export function makeShortAddress(sha256Fn: (data: string | Buffer) => string) {
  return function shortAddress(pubKeyPem: string) {
    return "dubz_" + sha256Fn(pubKeyPem).slice(0, 12);
  };
}

export function makeEnsureWallet(writeJSON: (path: string, obj: any) => void) {
  return function ensureWallet(path: string, shortAddress: (pubKeyPem: string) => string) {
    const existing = readJSON(path);
    if (existing?.publicKey && existing?.privateKey) return existing;

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pubPem = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
    const privPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

    const wallet = { publicKey: pubPem, privateKey: privPem, address: shortAddress(pubPem) };
    writeJSON(path, wallet);
    return wallet;
  };
}

export function readJSON(path: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function loadWalletFromFile(path: string) {
  const w = readJSON(path);
  if (!w?.publicKey || !w?.privateKey) return null;
  return w as WalletFileShape;
}

export function findWalletFileForAddress(
  shortAddr: string,
  shortAddress: (pubKeyPem: string) => string
): string | null {
  if (!shortAddr.startsWith("dubz_")) return null;
  try {
    const files = fs.readdirSync(".");
    for (const f of files) {
      if (!/^wallet\..+\.json$/.test(f)) continue;
      const w = readJSON(f);
      if (w?.publicKey && shortAddress(w.publicKey) === shortAddr) return f;
    }
  } catch {}
  return null;
}

export function resolveAddressToPublicKey(
  input: string,
  shortAddress: (pubKeyPem: string) => string
): { publicKey: string; via: string; walletFile?: string } | null {
  if (!input) return null;

  if (input.includes("BEGIN RSA PUBLIC KEY")) {
    return { publicKey: input, via: "publicKey" };
  }

  if (input.startsWith("dubz_")) {
    const walletFile = findWalletFileForAddress(input, shortAddress);
    if (!walletFile) return null;
    const w = loadWalletFromFile(walletFile);
    if (!w) return null;
    return { publicKey: w.publicKey, via: "shortAddress", walletFile };
  }

  if (fs.existsSync(input)) {
    const w = loadWalletFromFile(input);
    if (!w) return null;
    return { publicKey: w.publicKey, via: "walletFile", walletFile: input };
  }

  return null;
}

export async function submitTxToLocalNode(
  port: number,
  tx: WalletTxLike & { id: string },
  env: SubmitEnvelopeArgs
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        finish(false);
      }, 1500);

      ws.on("open", () => {
        const msg = {
          magic: env.networkMagic,
          chainId: env.chainId,
          version: env.protocolVersion,
          type: "TX",
          tx: tx.toJSON(),
        };
        ws.send(JSON.stringify(msg), (err) => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          finish(!err);
        });
      });

      ws.on("error", () => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

export function buildSignedTransferTx(args: {
  Tx: WalletTxCtor;
  fromWallet: WalletFileShape;
  toPublicKey: string;
  amount: number;
  fee: number;
  nonce: number;
}) {
  const tx = new args.Tx({
    type: "TRANSFER",
    from: args.fromWallet.publicKey,
    to: args.toPublicKey,
    amount: args.amount,
    fee: args.fee,
    nonce: args.nonce,
  });
  tx.sign(args.fromWallet.privateKey);
  return tx;
}