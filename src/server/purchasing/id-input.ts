import { type } from "arktype";

// The input of server functions that take one PO, line, or receipt by id.
export const id = type({ id: "number.integer > 0" });
