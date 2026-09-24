"use server";
import { dataSource } from "@/data/source";

export async function read(): Promise<unknown> {
  return dataSource;
}
