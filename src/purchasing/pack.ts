// Converts a price or count between pack sizes, e.g. $2 each is $60 a case of
// 30. On its own so the browser can work out what the server will save.
export const perPack = (perOld: number, oldPack: number, newPack: number) =>
	Math.round((perOld / oldPack) * newPack * 10_000) / 10_000;
