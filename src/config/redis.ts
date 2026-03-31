import Redis from "ioredis";
import { config } from "./index";

export const redis = new Redis(config.redis.url);
export const redisSub = new Redis(config.redis.url);
