
export interface Input {
  type: string[]; // List of compatible types (extracted from Union)
  required: boolean;
}

export interface Parameter {
  type: string;
  required: boolean;
}

export interface Output {
  type: string[];
}

export interface Action {
  description: string;
  inputs: Record<string, Input>;
  parameters: Record<string, Parameter>;
  metadata?: Record<string, Parameter>;
  outputs: Record<string, Output>;
}

export interface Plugin {
  actions: Record<string, Action>;
}

export interface Distribution {
  plugins: string[];
}

export interface Schema {
  plugins: Record<string, Plugin>;
  distributions: Record<string, Distribution>;
  types: Record<string, string>;
}
