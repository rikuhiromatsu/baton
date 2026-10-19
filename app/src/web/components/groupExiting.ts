// まとまりごと消えかけているとき true。中のカードも抜け殻として扱う（testid を外し、触れなくする）
import { createContext, useContext } from "react";

export const GroupExitingContext = createContext(false);

export function useGroupExiting(): boolean {
  return useContext(GroupExitingContext);
}
