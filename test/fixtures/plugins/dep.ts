export enum Status {
  Ok = 1,
}

export const label = (status: Status): string => Status[status]!;
