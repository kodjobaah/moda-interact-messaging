import {
  type RouteConfig,
  index,
  route,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  route("health", "routes/health.ts"),
  route("ready", "routes/ready.ts"),

  route("webhook/whatsapp", "routes/whatsapp.tsx"),
] satisfies RouteConfig;
