import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const TOKEN = __ENV.TOKEN || "";
const LIST_LIMIT = Number(__ENV.LIST_LIMIT || "80");

export const options = {
  vus: Number(__ENV.VUS || "25"),
  duration: __ENV.DURATION || "2m",
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<700", "p(99)<1200"],
  },
};

function authHeaders() {
  if (!TOKEN) return { "Content-Type": "application/json" };
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  };
}

export default function () {
  const headers = authHeaders();

  const listRes = http.get(
    `${BASE_URL}/api/orders?mode=cursor&limit=${LIST_LIMIT}`,
    { headers },
  );

  const listOk = check(listRes, {
    "orders list status is 200": (r) => r.status === 200,
  });

  if (!listOk) {
    sleep(1);
    return;
  }

  let firstOrderId = "";
  try {
    const body = listRes.json();
    if (body && Array.isArray(body.orders) && body.orders.length > 0) {
      firstOrderId = String(body.orders[0].id || "");
    }
  } catch (_) {
    // ignore parse errors; check will fail on subsequent detail request
  }

  if (firstOrderId) {
    const detailRes = http.get(`${BASE_URL}/api/orders/${firstOrderId}`, { headers });
    check(detailRes, {
      "order detail status is 200": (r) => r.status === 200,
    });
  }

  const searchTerm = __ENV.SEARCH_Q || "990";
  const searchRes = http.get(
    `${BASE_URL}/api/orders?mode=cursor&limit=30&q=${encodeURIComponent(searchTerm)}`,
    { headers },
  );
  check(searchRes, {
    "search status is 200": (r) => r.status === 200,
  });

  sleep(Number(__ENV.SLEEP_SEC || "0.5"));
}
