pub(crate) const DISCORD_LIMITS: pico_core::surface::SizeLimits = pico_core::surface::SizeLimits {
    message_cap: 1900,
    activity_line_cap: 20,
    activity_char_cap: 1800,
    activity_send_max: 1990,
};
pub(crate) const PLATFORM: &str = "discord";
