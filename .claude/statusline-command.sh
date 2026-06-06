
#!/usr/bin/env bash
# ~/.claude/statusline-command.sh
# Shows: model | effort | est. cost | context progress bar
#
# Cost is calculated from token counts in the status-line JSON using
# Anthropic's published per-model pricing (per million tokens):
#
#   Model          input    cache_write  cache_read  output
#   claude-opus-4  $15.00   $18.75       $1.50       $75.00
#   claude-sonnet* $3.00    $3.75        $0.30       $15.00
#   claude-haiku*  $0.80    $1.00        $0.08       $4.00
#
# Note: total_input_tokens includes cache_creation + cache_read tokens,
# so we subtract those before applying the base input rate.

input=$(cat)

model_id=$(printf '%s' "$input"   | jq -r '.model.id // ""')
model_name=$(printf '%s' "$input" | jq -r '.model.display_name // "Claude"')
effort=$(printf '%s' "$input"     | jq -r '.effort.level // empty')
used_pct=$(printf '%s' "$input"   | jq -r '.context_window.used_percentage // empty')

# Cumulative token counts for the session
in_tok=$(printf '%s' "$input"  | jq -r '.context_window.total_input_tokens // 0')
out_tok=$(printf '%s' "$input" | jq -r '.context_window.total_output_tokens // 0')
# Cache tokens come from the most-recent API call's current_usage
cache_w=$(printf '%s' "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
cache_r=$(printf '%s' "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')

# Select pricing tier by model ID prefix
case "$model_id" in
  claude-opus*)
    p_in=15.00; p_cw=18.75; p_cr=1.50; p_out=75.00 ;;
  claude-haiku*)
    p_in=0.80;  p_cw=1.00;  p_cr=0.08; p_out=4.00  ;;
  *)
    # Sonnet 3, 3-5, 4, 4-5 and any unknown model
    p_in=3.00;  p_cw=3.75;  p_cr=0.30; p_out=15.00  ;;
esac

# Calculate estimated cost (awk handles floating point)
cost=$(awk \
  -v in_tok="$in_tok" -v out_tok="$out_tok" \
  -v cache_w="$cache_w" -v cache_r="$cache_r" \
  -v p_in="$p_in" -v p_cw="$p_cw" -v p_cr="$p_cr" -v p_out="$p_out" '
BEGIN {
  plain_in = in_tok - cache_w - cache_r
  if (plain_in < 0) plain_in = 0
  total = (plain_in * p_in + cache_w * p_cw + cache_r * p_cr + out_tok * p_out) / 1000000
  if (total < 0.005)
    printf "$%.4f", total
  else if (total < 0.10)
    printf "$%.3f", total
  else
    printf "$%.2f", total
}')

# Build output string
out="$model_name"

[ -n "$effort" ] && out="$out | effort:${effort}"

out="$out | ~${cost}"

# Context progress bar (20 chars wide)
if [ -n "$used_pct" ] && [ "$used_pct" != "null" ]; then
  pct=$(printf '%.0f' "$used_pct")
  filled=$(awk -v p="$used_pct" 'BEGIN{printf "%d", (p*20/100)+0.5}')
  [ "$filled" -gt 20 ] && filled=20
  [ "$filled" -lt 0 ]  && filled=0
  bar=""
  i=0
  while [ "$i" -lt "$filled" ]; do bar="${bar}="; i=$((i+1)); done
  while [ "$i" -lt 20 ];       do bar="${bar}-"; i=$((i+1)); done
  out="$out | [${bar}] ${pct}%"
fi

printf '%s' "$out"