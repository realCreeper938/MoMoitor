/**
 * Lunar Calendar Library (Lightweight)
 * Supports Gregorian to Lunar conversion and Chinese holidays
 */

const Lunar = (() => {
    // Lunar calendar data from 1900 to 2100
    // Each entry encodes:
    // - Bits 0-3: leap month (0 = no leap)
    // - Bits 4-15: which months have 30 days (1) vs 29 days (0)
    // - Bits 16-19: leap month days (0=29, 1=30)
    const lunarInfo = [
        0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
        0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
        0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
        0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
        0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
        0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
        0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
        0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
        0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
        0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
        0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
        0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
        0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
        0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
        0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
        0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
        0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
        0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
        0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
        0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252,
        0x0d520
    ];

    const Gan = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
    const Zhi = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
    const Animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
    const MonthCN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
    const DayCN1 = ['初', '十', '廿', '三十'];
    const DayCN2 = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

    function dayCN(d) {
        if (d === 10) return '初十';
        if (d === 20) return '二十';
        if (d === 30) return '三十';
        return DayCN1[Math.floor(d / 10)] + DayCN2[d % 10];
    }

    function leapMonth(y) {
        return lunarInfo[y - 1900] & 0xf;
    }

    function leapDays(y) {
        if (leapMonth(y)) {
            return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29;
        }
        return 0;
    }

    function monthDays(y, m) {
        if (m > 12 || m < 1) return -1;
        return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29;
    }

    function yearDays(y) {
        let sum = 348;
        for (let i = 0x8000; i > 0x8; i >>= 1) {
            sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
        }
        return sum + leapDays(y);
    }

    function solar2lunar(y, m, d) {
        if (y < 1900 || y > 2100) return null;
        if (y === 1900 && m === 1 && d < 31) return null;

        let offset = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);

        let lunarYear, lunarMonth, lunarDay, isLeap = false;

        for (lunarYear = 1900; lunarYear < 2101 && offset > 0; lunarYear++) {
            let daysInYear = yearDays(lunarYear);
            offset -= daysInYear;
        }
        if (offset < 0) {
            offset += yearDays(--lunarYear);
        }

        let leap = leapMonth(lunarYear);
        let isLeapYear = false;

        for (lunarMonth = 1; lunarMonth < 13 && offset > 0; lunarMonth++) {
            if (leap > 0 && lunarMonth === (leap + 1) && !isLeapYear) {
                --lunarMonth;
                isLeapYear = true;
                let daysInMonth = leapDays(lunarYear);
                offset -= daysInMonth;
            } else {
                let daysInMonth = monthDays(lunarYear, lunarMonth);
                offset -= daysInMonth;
            }

            if (isLeapYear && lunarMonth === (leap + 1)) {
                isLeapYear = false;
            }
        }

        if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
            if (isLeapYear) {
                isLeapYear = false;
            } else {
                isLeapYear = true;
                --lunarMonth;
            }
        }

        if (offset < 0) {
            offset += isLeapYear ? leapDays(lunarYear) : monthDays(lunarYear, lunarMonth);
            --lunarMonth;
        }

        lunarDay = offset + 1;
        isLeap = isLeapYear;

        // Heavenly Stem and Earthly Branch
        const ganIndex = (lunarYear - 4) % 10;
        const zhiIndex = (lunarYear - 4) % 12;
        const ganZhi = Gan[ganIndex] + Zhi[zhiIndex];
        const animal = Animals[zhiIndex];

        return {
            lYear: lunarYear,
            lMonth: lunarMonth,
            lDay: lunarDay,
            isLeap: isLeap,
            ganZhi: ganZhi,
            animal: animal,
            monthCN: (isLeap ? '闰' : '') + MonthCN[lunarMonth - 1] + '月',
            dayCN: dayCN(lunarDay),
            fullCN: (isLeap ? '闰' : '') + MonthCN[lunarMonth - 1] + '月' + dayCN(lunarDay)
        };
    }

    // Chinese festivals (Gregorian calendar)
    const festivals = {
        '1-1': '元旦',
        '2-14': '情人节',
        '3-8': '妇女节',
        '3-12': '植树节',
        '4-1': '愚人节',
        '5-1': '劳动节',
        '5-4': '青年节',
        '6-1': '儿童节',
        '7-1': '建党节',
        '8-1': '建军节',
        '9-10': '教师节',
        '10-1': '国庆节',
        '12-25': '圣诞节'
    };

    // Lunar festivals
    const lunarFestivals = {
        '1-1': '春节',
        '1-15': '元宵节',
        '5-5': '端午节',
        '7-7': '七夕',
        '7-15': '中元节',
        '8-15': '中秋节',
        '9-9': '重阳节',
        '12-30': '除夕',
        '12-29': '除夕'  // For months with 29 days
    };

    // Solar terms (approximate)
    const solarTerms = [
        '小寒', '大寒', '立春', '雨水', '惊蛰', '春分',
        '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
        '小暑', '大暑', '立秋', '处暑', '白露', '秋分',
        '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'
    ];

    // Solar term dates (approximate for calculation)
    const sTermInfo = [
        0, 21208, 42467, 63836, 85337, 107014,
        128867, 150921, 173149, 195551, 218072, 240693,
        263343, 285989, 308563, 331033, 353350, 375494,
        397447, 419210, 440795, 462224, 483532, 504758
    ];

    function getSolarTerm(y, n) {
        const offDate = new Date((31556925974.7 * (y - 1900) + sTermInfo[n] * 60000) + Date.UTC(1900, 0, 6, 2, 5));
        return {
            month: Math.floor(n / 2) + 1,
            day: offDate.getUTCDate()
        };
    }

    function getSolarTermForDate(y, m, d) {
        const n = (m - 1) * 2;
        const term1 = getSolarTerm(y, n);
        const term2 = getSolarTerm(y, n + 1);
        if (term1.day === d) return solarTerms[n];
        if (term2.day === d) return solarTerms[n + 1];
        return null;
    }

    function getFestival(m, d) {
        return festivals[m + '-' + d] || null;
    }

    function getLunarFestival(lunarMonth, lunarDay, isLeap) {
        if (isLeap) return null;
        return lunarFestivals[lunarMonth + '-' + lunarDay] || null;
    }

    return {
        solar2lunar,
        getFestival,
        getLunarFestival,
        getSolarTermForDate
    };
})();
