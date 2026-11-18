try {
    var stored = JSON.parse(localStorage.getItem("infinite-canvas:theme_store") || "{}");
    var theme = stored.state && stored.state.theme === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
} catch (error) {
    // Ignore malformed theme state and fall back to the dark default.
}
