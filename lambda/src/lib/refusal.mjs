// A request the controller understood and refuses (vision refusals design §1): invalid, not_found, conflict or
// unsupported. Thrown as an Error with its message, it is an answer for a caller that says it reads refusals.
export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const refused = (err) => ({ refused: { code: err.code, message: err.message } });
