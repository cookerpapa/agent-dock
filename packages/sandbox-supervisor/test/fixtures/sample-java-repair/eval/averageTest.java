public final class averageTest {
    public static void main(String[] args) {
        if (Calculator.average(2, 5) != 3.5) throw new AssertionError("average");
        System.out.println("average passed");
    }
}
