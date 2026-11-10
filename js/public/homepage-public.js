document.addEventListener("DOMContentLoaded", function () {
    // Pause the hero carousel when the user prefers reduced motion.
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        var carouselElement = document.getElementById("heroCarousel");
        if (carouselElement && typeof bootstrap !== "undefined") {
            function pauseHeroCarousel() {
                var carousel = bootstrap.Carousel.getInstance(carouselElement);
                if (carousel) {
                    carousel.pause();
                }
                return !!carousel;
            }

            if (!pauseHeroCarousel()) {
                setTimeout(pauseHeroCarousel, 0);
            }
        }
    }

    // Mobile bottom-sheet nav: close the drawer when a link is tapped without
    // blocking navigation. (Bootstrap's `data-bs-dismiss` cancels the click,
    // which prevented the About / Contact / Login links from ever navigating.)
    var drawerEl = document.getElementById("hpDrawer");
    if (drawerEl && typeof bootstrap !== "undefined") {
        drawerEl.querySelectorAll('a[href]').forEach(function (link) {
            link.addEventListener("click", function () {
                var instance = bootstrap.Offcanvas.getInstance(drawerEl);
                if (instance) {
                    instance.hide();
                }
            });
        });
    }
});
