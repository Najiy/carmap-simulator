/**
 * The list of driving scenes, with no three.js in it — the lobby and the
 * scene picker need the names long before anyone loads the 3D chunk.
 */

export type SceneId = "airfield" | "circuit" | "city" | "mile";

export interface SceneDef {
  id: SceneId;
  name: string;
  blurb: string;
}

/** the scenes a multiplayer race can be held on */
export const RACE_SCENES: SceneId[] = ["circuit", "mile"];

export const SCENES: SceneDef[] = [
  {
    id: "airfield",
    name: "Airfield",
    blurb: "Open tarmac, a painted skidpad and a slalom. Nothing to hit.",
  },
  {
    id: "circuit",
    name: "Test circuit",
    blurb: "A closed loop with kerbs and armco — somewhere to string corners together.",
  },
  {
    id: "city",
    name: "City blocks",
    blurb: "A grid of streets and buildings. Tight, and the walls are solid.",
  },
  {
    id: "mile",
    name: "The mile",
    blurb: "Two kilometres of runway with distance boards. For top speed.",
  },
];
