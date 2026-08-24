/**
 * A stand-in for node's `buffer` module, aliased in at build time.
 *
 * scattergl pulls in typedarray-pool, whose only use of Buffer is an
 * `isBuffer` guard and a `mallocBuffer` helper Plotly never calls. Reporting
 * "not a Buffer" sends it down the ArrayBuffer path, which is the correct one
 * in a browser. The alternative is a real Buffer polyfill, tens of kilobytes
 * to answer one question with `false`.
 */
export const Buffer = {
	isBuffer(): boolean {
		return false;
	},
};

export default { Buffer };
