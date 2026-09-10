/* eslint-disable @typescript-eslint/no-unused-vars */

var levelOrder = ["SEVERE", "HIGH", "ELEVATED", "UNKNOWN", "NORMAL"]
var healthStates = ["ok", "warming", "degraded"]
var freshnessStates = ["fresh", "warming", "delayed"]

function clampRefreshInterval(value) {
  var parsed = parseInt(String(value), 10)
  if (!isFinite(parsed)) parsed = 300
  return Math.max(60, Math.min(3600, parsed))
}

function normalizeServiceUrl(value) {
  var input = String(value || "").trim()
  var match = input.match(/^http:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::(\d{1,5}))?\/?$/i)
  if (!match) return ""
  var host = match[1].toLowerCase()
  if (host.indexOf("127") === 0) {
    var octets = host.split(".")
    if (octets.length !== 4 || octets[0] !== "127") return ""
    for (var i = 1; i < octets.length; i++) {
      if (!/^\d+$/.test(octets[i]) || Number(octets[i]) > 255) return ""
    }
  }
  var port = match[2] ? Number(match[2]) : 80
  if (port < 1 || port > 65535) return ""
  return "http://" + host + (match[2] ? ":" + String(port) : "")
}

function boundedText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().substring(0, max)
}

function validCount(value) {
  var number = Number(value)
  return isFinite(number) && number >= 0 && Math.floor(number) === number ? number : -1
}

function parseSummary(raw) {
  var value
  try { value = JSON.parse(String(raw || "")) } catch (_) { return null }
  if (!value || value.schemaVersion !== 1 || typeof value.appVersion !== "string" || value.catalogVersion !== 3) return null
  if (healthStates.indexOf(value.health) === -1 || freshnessStates.indexOf(value.freshness) === -1) return null
  if (typeof value.generatedAt !== "string" || isNaN(Date.parse(value.generatedAt))) return null
  if (!value.restrictedSources || typeof value.restrictedSources.active !== "boolean") return null
  if (!value.counts || !Array.isArray(value.destinations) || value.destinations.length > 10) return null
  var counts = {}
  var countKeys = ["NORMAL", "ELEVATED", "HIGH", "SEVERE", "UNKNOWN", "attention"]
  for (var c = 0; c < countKeys.length; c++) {
    var count = validCount(value.counts[countKeys[c]])
    if (count < 0) return null
    counts[countKeys[c]] = count
  }
  if (counts.NORMAL + counts.ELEVATED + counts.HIGH + counts.SEVERE + counts.UNKNOWN !== 679) return null
  if (counts.attention !== counts.ELEVATED + counts.HIGH + counts.SEVERE + counts.UNKNOWN) return null
  var restrictedCount = validCount(value.restrictedSources.count)
  if (restrictedCount < 0) return null
  var destinations = []
  for (var i = 0; i < value.destinations.length; i++) {
    var item = value.destinations[i]
    if (!item || !/^[a-z]{2}-[a-z0-9-]{1,80}$/.test(String(item.id || "")) || levelOrder.indexOf(item.level) === -1) return null
    destinations.push({
      id: String(item.id),
      name: boundedText(item.name, 100) || String(item.id),
      countryCode: /^[A-Z]{2}$/.test(String(item.countryCode || "")) ? String(item.countryCode) : "",
      level: String(item.level),
      updatePending: item.updatePending === true
    })
  }
  return {
    schemaVersion: 1,
    appVersion: boundedText(value.appVersion, 32),
    catalogVersion: 3,
    health: value.health,
    freshness: value.freshness,
    generatedAt: value.generatedAt,
    restrictedSources: {
      active: value.restrictedSources.active,
      count: restrictedCount,
      disclosure: value.restrictedSources.active ? boundedText(value.restrictedSources.disclosure, 180) : ""
    },
    counts: counts,
    destinations: destinations
  }
}

function strongestState(summary) {
  if (!summary || !summary.counts) return "UNAVAILABLE"
  for (var i = 0; i < levelOrder.length; i++) if (summary.counts[levelOrder[i]] > 0) return levelOrder[i]
  return "NORMAL"
}

function attentionCount(summary) {
  return summary && summary.counts ? Math.max(0, Number(summary.counts.attention) || 0) : 0
}

function destinationUrl(serviceUrl, id) {
  var origin = normalizeServiceUrl(serviceUrl)
  var destination = String(id || "")
  if (!origin || !/^[a-z]{2}-[a-z0-9-]{1,80}$/.test(destination)) return ""
  return origin + "/?destination=" + encodeURIComponent(destination)
}

function stateLabel(level) {
  var labels = { SEVERE: "Severe", HIGH: "High", ELEVATED: "Elevated", UNKNOWN: "Update pending", NORMAL: "Normal", UNAVAILABLE: "Unavailable" }
  return labels[level] || "Unavailable"
}

function updatedLabel(summary) {
  if (!summary || !summary.generatedAt) return "No successful response"
  var date = new Date(summary.generatedAt)
  return isNaN(date.getTime()) ? "No successful response" : date.toLocaleString()
}
