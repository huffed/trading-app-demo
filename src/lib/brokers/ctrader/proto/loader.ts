/**
 * Loads the cTrader Open API protobuf schema. The descriptor.json file
 * is generated from Spotware's official .proto files via:
 *
 *   pnpm proto:gen
 *
 * (See package.json — runs pbjs --target json over the four .proto files
 * in this directory.) Importing the JSON statically lets Next.js bundle
 * it with the route handler — no file-system reads at runtime, which
 * matters for serverless deployments where __dirname can be unreliable.
 */
import protobuf from "protobufjs";
import descriptor from "./descriptor.json";

let cachedRoot: protobuf.Root | null = null;

export function getProtoRoot(): protobuf.Root {
  if (cachedRoot) return cachedRoot;
  // protobufjs.Root.fromJSON parses the descriptor synchronously — no
  // promise plumbing needed, which keeps the call sites simpler.
  cachedRoot = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
  return cachedRoot;
}

/** Lookup a message type by fully-qualified name. Throws a helpful error
 *  when the descriptor doesn't include it (typo, schema drift) so the
 *  bug surfaces at the call site rather than as a cryptic encode/decode
 *  failure later. */
export function lookupType(name: string): protobuf.Type {
  const root = getProtoRoot();
  const type = root.lookupType(name);
  if (!type) throw new Error(`cTrader proto: missing message type "${name}"`);
  return type;
}
